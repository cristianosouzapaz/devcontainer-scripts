# Holds one of the mod's host locks: a kernel flock on a permanent lock file, taken first come, first served through a
# queue of ticket files that each waiter keeps flocked for as long as it lives. The lock dies with its holder, so no
# reader ever judges a lock by its age.
#
#   perl host-lock.pl wait <lock> <id> [--wait <s>] [--watch <dir>] [--kill-group <file>] [--legacy <dir> --legacy-stale <s>] [--renames]
#       Queues for the lock under <id> and holds it until this process ends. Prints `pid <pid>` first, so its caller can end it
#       with SIGTERM, then, with --renames, `ticket <path>`, its ticket, then one line per event: `pos <n> <m>` (n-th of m in the queue), `locked`,
#       `timeout` (the wait ran out before the lock), and `poke`
#       (the watched directory's entries changed). It ends when its parent is gone, on SIGTERM, SIGINT or SIGHUP,
#       or once its stdout is closed; the kernel frees the lock and the ticket in any case, SIGKILL included.
#       With --renames, while it holds the lock it renames for its caller: a request file `<ticket>.mv` holding the source, the
#       target and `end`, one per line, is renamed by this process, which holds the flock through the rename, so no rename lands
#       once the lock is lost; it then removes the request and prints `renamed` or `rename-failed <reason>`.
#       With --kill-group, a holder that ends stops the process group whose id the file holds before it lets the lock go,
#       so a command its dead session started never overlaps the next holder's.
#   perl host-lock.pl list <lock>
#       Prints the live queue, one `<state> <id>` line per ticket: while the lock is held, `held` and the ticket its holder marked
#       first, or the first live ticket in arrival order while none carries the mark; then `wait` for the others, in arrival order.
#   perl host-lock.pl held <lock>
#       Prints the holder's id and exits 0 while the lock is held; exits 1 while it is free.
#
# Only perl-base modules are used. Nothing forks, and perl opens every fd above stderr close-on-exec, so no child ever
# inherits the lock. The lock lives on a local filesystem: flock over a network filesystem is not supported.
use strict;
use warnings;
use Fcntl qw(:flock O_RDWR O_CREAT O_EXCL);
use POSIX qw(EEXIST ENOENT);

# why: an orphan check, a poke and a lock attempt each wait at most this long, so a dead parent frees the lock within about a second.
my $tick = 0.25;
# why: a legacy lock is judged by its age by sessions older than this script, so it is renewed well inside their 30 s lease.
my $legacy_renew = 5;
my $ticket_pattern = qr/^\d{12}$/;
# why: how often a holder serving renames looks for a request, so a publish's rename waits only this long.
my $rename_tick = 0.01;

# why: a group stopped with SIGTERM gets this many 50 ms looks, time for its log readers to flush, before SIGKILL.
my $kill_grace_ticks = 40;

my %state = (ticket => undef, staged => undef, legacy => undef, kill_group => undef, is_locked => 0);

# fail <message>: prints the message on stderr and exits 2.
sub fail {
	my ($message) = @_;
	print STDERR "host-lock: $message\n";
	cleanup();
	exit 2;
}

# say_line <text>: prints one event line, unbuffered.
sub say_line {
	my ($text) = @_;
	print STDOUT "$text\n";
}

# nap: sleeps one tick.
sub nap { select(undef, undef, undef, $tick) }

# open_rw <path>: opens a file for reading and writing, creating it, or returns undef when it is gone.
sub open_rw {
	my ($path, $is_created) = @_;
	my $flags = O_RDWR | ($is_created ? O_CREAT : 0);
	my $handle;
	return sysopen($handle, $path, $flags, 0666) ? $handle : undef;
}

# ensure_dir <path>: creates a directory unless it exists.
sub ensure_dir {
	my ($path) = @_;
	mkdir $path or $! == EEXIST or fail("cannot create $path: $!");
}

# next_sequence <lock>: draws the next arrival number from the counter beside the lock, under its own flock.
sub next_sequence {
	my ($lock) = @_;
	my $handle = open_rw("$lock.seq", 1) or fail("cannot open $lock.seq: $!");
	flock($handle, LOCK_EX) or fail("cannot lock $lock.seq: $!");
	my $text = <$handle> // '0';
	my $value = ($text =~ /^(\d+)/ ? $1 : 0) + 1;
	seek($handle, 0, 0);
	truncate($handle, 0);
	print {$handle} "$value\n";
	close($handle);
	return $value;
}

# read_ticket <handle>: reads a ticket's id, its first line, and whether its second line marks it as the holder's.
sub read_ticket {
	my ($handle) = @_;
	seek($handle, 0, 0);
	my $id = <$handle> // '';
	my $mark = <$handle> // '';
	chomp $id;
	chomp $mark;
	return ($id, $mark eq 'held');
}

# live_tickets <queue> <own>: lists the live tickets in arrival order as [name, id, is_holder] triples, removing each one whose owner is gone.
# Notes: a ticket nobody holds a flock on belongs to a process that ended, so it is removed at once, with no age judgement.
sub live_tickets {
	my ($queue, $own) = @_;
	my $dir;
	# why: a queue never made holds no ticket; any other error leaves the queue unknown, which is never an empty one.
	if (!opendir($dir, $queue)) {
		return () if $! == ENOENT;
		fail("cannot read $queue: $!");
	}
	my @names = sort grep { $_ =~ $ticket_pattern } readdir($dir);
	closedir($dir);
	my @live;
	for my $name (@names) {
		my $path = "$queue/$name";
		if (defined $own && $name eq $own->{name}) {
			push @live, [$name, $own->{id}, $state{is_locked}];
			next;
		}
		my $handle = open_rw($path, 0);
		if (!$handle) {
			next if $! == ENOENT;
			fail("cannot open $path: $!");
		}
		if (flock($handle, LOCK_EX | LOCK_NB)) {
			unlink $path, "$path.mv";
			close($handle);
			next;
		}
		push @live, [$name, read_ticket($handle)];
		close($handle);
	}
	return @live;
}

# is_held <lock>: tells whether some process holds the lock, without waiting for it.
sub is_held {
	my ($lock) = @_;
	my $handle = open_rw($lock, 0);
	# why: a lock file never made has no holder; any other error leaves the holder unknown, which is never a free lock.
	if (!$handle) {
		return 0 if $! == ENOENT;
		fail("cannot open $lock: $!");
	}
	my $is_free = flock($handle, LOCK_SH | LOCK_NB);
	close($handle);
	return !$is_free;
}

# take_ticket <lock> <id>: joins the queue with a flocked ticket, staged under a name no sweep reads, then renamed into place.
# Notes: the staged name is the arrival number, unique across pid namespaces sharing the directory, where a pid is not.
sub take_ticket {
	my ($lock, $id) = @_;
	my $queue = "$lock.q";
	ensure_dir($queue);
	my $name = sprintf('%012d', next_sequence($lock));
	my $staged = "$queue/.new-$name";
	my $handle;
	sysopen($handle, $staged, O_RDWR | O_CREAT | O_EXCL, 0666) or fail("cannot create $staged: $!");
	$state{staged} = $staged;
	flock($handle, LOCK_EX | LOCK_NB) or fail("cannot lock $staged: $!");
	print {$handle} "$id\n";
	$handle->flush();
	rename($staged, "$queue/$name") or fail("cannot queue $name: $!");
	$state{staged} = undef;
	$state{ticket} = { path => "$queue/$name", name => $name, id => $id, handle => $handle };
	return $state{ticket};
}

# signature <dir>: names a directory's entries, so a change in them reads as a poke whatever the clock's resolution.
sub signature {
	my ($path) = @_;
	return '' unless defined $path;
	opendir(my $dir, $path) or return '-';
	my $names = join("\0", sort grep { $_ ne '.' && $_ ne '..' } readdir($dir));
	closedir($dir);
	return $names;
}

# remove_tree_shallow <dir>: removes a legacy lock directory and the files directly in it.
sub remove_tree_shallow {
	my ($path) = @_;
	if (opendir(my $dir, $path)) {
		unlink map { "$path/$_" } grep { $_ ne '.' && $_ ne '..' } readdir($dir);
		closedir($dir);
	}
	rmdir $path;
}

# take_legacy <dir> <stale>: takes the mkdir lock sessions older than this script wait on; returns false while another holds it.
# Notes: a legacy lock marked by this script was left by a holder that died, since this process holds the flock now; an unmarked
# one belongs to an older session and is broken only past the age that session itself judges it dead at.
sub take_legacy {
	my ($path, $stale) = @_;
	if (mkdir $path) {
		my $handle = open_rw("$path/host-lock", 1);
		close($handle) if $handle;
		$state{legacy} = $path;
		return 1;
	}
	# why: a repository no older session has used holds no legacy directory, so its parent is made here and the lock taken at the next look.
	if ($! == ENOENT) {
		my ($parent) = $path =~ m{^(.*)/[^/]+$};
		mkdir $parent or $! == EEXIST or fail("cannot create $parent: $!");
		return 0;
	}
	fail("cannot take the legacy lock $path: $!") unless $! == EEXIST;
	my @info = stat($path);
	return 0 unless @info;
	if (-e "$path/host-lock" || time() - $info[9] > $stale) {
		my $moved = "$path.stale-" . time() . "-$$-" . int(rand(1 << 30));
		remove_tree_shallow($moved) if rename($path, $moved);
	}
	return 0;
}

# kill_group <file>: stops the process group whose id the file holds, SIGTERM first, then SIGKILL past the grace.
sub kill_group {
	my ($path) = @_;
	open(my $handle, '<', $path) or return;
	my $text = <$handle> // '';
	close($handle);
	return unless $text =~ /^\s*(\d+)\s*$/ && $1 > 1;
	my $group = $1;
	kill('TERM', -$group) or return;
	for (1 .. $kill_grace_ticks) {
		return unless kill(0, -$group);
		select(undef, undef, undef, 0.05);
	}
	kill('KILL', -$group);
}

# cleanup: stops the held work's command group, gives back the legacy lock and removes this process's ticket; the kernel drops the flocks as the process exits.
sub cleanup {
	kill_group($state{kill_group}) if $state{is_locked} && defined $state{kill_group};
	$state{kill_group} = undef;
	remove_tree_shallow($state{legacy}) if defined $state{legacy};
	$state{legacy} = undef;
	unlink $state{staged} if defined $state{staged};
	unlink $state{ticket}{path}, "$state{ticket}{path}.mv" if defined $state{ticket};
	$state{ticket} = undef;
}

# finish: cleans up and exits 0.
sub finish {
	cleanup();
	exit 0;
}

# parse_options <args>: reads the wait mode's options.
sub parse_options {
	my %options;
	while (@_) {
		my $name = shift;
		if ($name eq '--renames') {
			$options{renames} = 1;
			next;
		}
		fail("unknown option $name") unless $name =~ /^--(wait|watch|kill-group|legacy|legacy-stale)$/;
		fail("$name needs a value") unless @_;
		$options{$1} = shift;
	}
	fail('--legacy needs --legacy-stale') if defined $options{legacy} && !defined $options{'legacy-stale'};
	return \%options;
}

# serve_rename <ticket>: renames what the ticket's request file asks while this process holds the lock, then reports it.
# Notes: a request still being written has no `end` line yet, so it is left for the next look.
sub serve_rename {
	my ($ticket) = @_;
	my $request = "$ticket->{path}.mv";
	open(my $handle, '<', $request) or return;
	my @lines = <$handle>;
	close($handle);
	chomp @lines;
	return unless @lines == 3 && $lines[2] eq 'end';
	my $is_renamed = rename($lines[0], $lines[1]);
	my $reason = "$!";
	unlink $request;
	say_line($is_renamed ? 'renamed' : "rename-failed $reason");
}

# wait_mode <lock> <id> <options>: queues for the lock, then holds it until this process ends.
sub wait_mode {
	my ($lock, $id, @rest) = @_;
	fail('wait needs <lock> <id>') unless defined $id && length $id;
	fail('an id is one line') if $id =~ /\n/;
	my $options = parse_options(@rest);
	$state{kill_group} = $options->{'kill-group'};
	my $parent = getppid();
	$SIG{$_} = \&finish for qw(TERM INT HUP PIPE);
	$| = 1;
	say_line("pid $$");
	my $lock_handle = open_rw($lock, 1) or fail("cannot open $lock: $!");
	my $own = take_ticket($lock, $id);
	say_line("ticket $own->{path}") if $options->{renames};
	my $started = time();
	my $watched = signature($options->{watch});
	my $shown = '';
	my $is_locked = 0;
	my $has_flock = 0;
	my $renewed = 0;
	while (1) {
		finish() if getppid() != $parent;
		if (defined $options->{watch}) {
			my $now = signature($options->{watch});
			if ($now ne $watched) {
				$watched = $now;
				say_line('poke');
			}
		}
		if ($is_locked) {
			if (defined $state{legacy} && time() - $renewed >= $legacy_renew) {
				utime(undef, undef, $state{legacy});
				$renewed = time();
			}
			# why: a rename request waits on this look, so a holder that serves them looks often while it holds, which is only as long as its caller's work.
			if ($options->{renames}) {
				serve_rename($own);
				select(undef, undef, undef, $rename_tick);
				next;
			}
			nap();
			next;
		}
		my @live = live_tickets("$lock.q", $own);
		my ($index) = grep { $live[$_][0] eq $own->{name} } 0 .. $#live;
		fail("this waiter's ticket $own->{name} is gone") unless defined $index;
		my $position = sprintf('pos %d %d', $index + 1, scalar @live);
		if ($position ne $shown) {
			$shown = $position;
			say_line($position);
		}
		# why: the head keeps the flock while an older session still holds the legacy lock, so nobody behind it can take either.
		$has_flock ||= $index == 0 && flock($lock_handle, LOCK_EX | LOCK_NB);
		if ($has_flock && (!defined $options->{legacy} || take_legacy($options->{legacy}, $options->{'legacy-stale'}))) {
			# why: readers name the holder by this mark, never by arrival order, which a ticket re-created under a lower number breaks.
			seek($own->{handle}, 0, 2);
			print {$own->{handle}} "held\n";
			$own->{handle}->flush();
			$is_locked = 1;
			$state{is_locked} = 1;
			$renewed = time();
			say_line('locked');
			next;
		}
		if (defined $options->{wait} && time() - $started >= $options->{wait}) {
			say_line('timeout');
			finish();
		}
		nap();
	}
}

# holder_index <live>: names the index of the live ticket its holder marked, or of the first one while none carries the mark,
# or undef while the queue is empty.
# Notes: a holder of an older script never marks its ticket, and took the lock as the first in arrival order, so that ticket names it.
sub holder_index {
	my @live = @_;
	my ($marked) = grep { $live[$_][2] } 0 .. $#live;
	return $marked // (@live ? 0 : undef);
}

# list_mode <lock>: prints the live queue, the holder first.
sub list_mode {
	my ($lock) = @_;
	my @live = live_tickets("$lock.q", undef);
	my $is_held = is_held($lock);
	my $holder = $is_held ? holder_index(@live) : undef;
	# why: a held lock is never listed as free, even while no live ticket names its holder.
	say_line('held ' . (defined $holder ? $live[$holder][1] : '')) if $is_held;
	say_line("wait $live[$_][1]") for grep { !defined $holder || $_ != $holder } 0 .. $#live;
	exit 0;
}

# held_mode <lock>: prints the holder's id while the lock is held, empty while no live ticket names it.
sub held_mode {
	my ($lock) = @_;
	exit 1 unless is_held($lock);
	my @live = live_tickets("$lock.q", undef);
	my $holder = holder_index(@live);
	say_line(defined $holder ? $live[$holder][1] : '');
	exit 0;
}

my ($mode, $lock, @args) = @ARGV;
fail('usage: host-lock.pl wait|list|held <lock> ...') unless defined $mode && defined $lock && length $lock;
wait_mode($lock, @args) if $mode eq 'wait';
list_mode($lock) if $mode eq 'list';
held_mode($lock) if $mode eq 'held';
fail("unknown mode $mode");
