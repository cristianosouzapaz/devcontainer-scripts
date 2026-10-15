import { expect, test } from 'claude-code/testing'

import { findRanCommands, hasExactSegment, listWriteTargets, splitShellWords } from '../../hooks/lib/shell-parser'

// The shell runs in /w, with /home/u as its home.
const context = { cwd: '/w', home: '/home/u' }

// The words of each segment, as plain text with a redirect shown as '>'.
const listSegmentTexts = (command: string): string[][] => splitShellWords(command).map(segment => segment.map(word => word.text))

test('splitShellWords splits segments on unquoted separators and keeps quoted text in one word', () => {
  expect(listSegmentTexts('a b && c; d | e & f || g\nh')).toEqual([['a', 'b'], ['c'], ['d'], ['e'], ['f'], ['g'], ['h']])
  expect(listSegmentTexts(`echo "a; b" 'c && d'`)).toEqual([['echo', 'a; b', 'c && d']])
  expect(listSegmentTexts('echo a\\\nb')).toEqual([['echo', 'ab']])
})

test('splitShellWords flags a redirect as a word of its own and drops fd duplications', () => {
  const words = splitShellWords('cmd 2>err >> out 2>&1')[0]!
  expect(words.map(word => [word.text, !!word.isRedirect])).toEqual([['cmd', false], ['>', true], ['err', false], ['>', true], ['out', false]])
})

test('listWriteTargets lists redirect, tee, cp, mv and sed -i targets, resolved against the working directory', () => {
  expect(listWriteTargets('echo x > a.txt', context)).toEqual(['/w/a.txt'])
  expect(listWriteTargets('echo x | tee -a b.txt c.txt', context)).toEqual(['/w/b.txt', '/w/c.txt'])
  expect(listWriteTargets('cp src dst && mv old /abs/new', context)).toEqual(['/w/dst', '/abs/new'])
  expect(listWriteTargets("sudo sed -i 's/a/b/' f.txt", context)).toEqual(['/w/f.txt'])
  expect(listWriteTargets('cat a.txt; echo "a > b"; sed s/a/b/ a.txt; grep -r "tee" .', context)).toEqual([])
})

test('listWriteTargets reads a clobbering redirect and a redirect of both streams to a file as writes', () => {
  expect(listWriteTargets('echo x >| a.txt', context)).toEqual(['/w/a.txt'])
  expect(listWriteTargets('echo x >& a.txt', context)).toEqual(['/w/a.txt'])
  expect(listWriteTargets('echo x >&2; echo y 2>&-', context)).toEqual([])
})

test('a quoted word names a program where it opens the run, and never as an argument', () => {
  expect(listWriteTargets('"cp" /tmp/x a.txt', context)).toEqual(['/w/a.txt'])
  expect(findRanCommands("'git' commit -m x", 'git commit')).toHaveLength(1)
  expect(findRanCommands('echo "git" commit', 'git commit')).toEqual([])
})

test('listWriteTargets finds writes in sh -c, eval, substitutions and behind prefixes or program paths', () => {
  expect(listWriteTargets("bash -c 'echo x > a.txt'", context)).toEqual(['/w/a.txt'])
  expect(listWriteTargets("eval 'echo x > a.txt'", context)).toEqual(['/w/a.txt'])
  expect(listWriteTargets('echo "$(echo x > a.txt)"', context)).toEqual(['/w/a.txt'])
  expect(listWriteTargets('command cp /tmp/x a.txt; timeout 5 /bin/mv b c', context)).toEqual(['/w/a.txt', '/w/c'])
})

test('listWriteTargets resolves a relative target against the last literal cd before it', () => {
  expect(listWriteTargets('cd /tmp/scratch && echo x > f.txt', context)).toEqual(['/tmp/scratch/f.txt'])
  expect(listWriteTargets('cd sub; pushd ../other && echo x > f', context)).toEqual(['/w/other/f'])
  expect(listWriteTargets('cd; echo x > f', context)).toEqual(['/home/u/f'])
  // A subshell, a substitution and sh -c keep their cd to themselves; eval does not.
  expect(listWriteTargets('(cd /tmp && make) && echo x > f', context)).toEqual(['/w/f'])
  expect(listWriteTargets("bash -c 'cd /tmp' && echo x > f", context)).toEqual(['/w/f'])
  expect(listWriteTargets("eval 'cd /tmp' && echo x > f", context)).toEqual(['/tmp/f'])
})

test('listWriteTargets yields null for a target it cannot resolve, and for a line it cannot parse', () => {
  expect(listWriteTargets('echo y > "$F"; echo z > `pwd`/a; echo w > ~other/a', context)).toEqual([null, null, null])
  expect(listWriteTargets('cd $X && echo x > f && echo y > /abs', context)).toEqual([null, '/abs'])
  expect(listWriteTargets('cd - && echo x > f; popd; echo y > g', context)).toEqual([null, null])
  expect(listWriteTargets('echo x > f "open', context)).toEqual([null])
})

test('listWriteTargets resolves ~ against the home directory, unresolved without one, and leaves out /dev and heredoc bodies', () => {
  expect(listWriteTargets('echo x > ~/a; echo y > ~', context)).toEqual(['/home/u/a', '/home/u'])
  expect(listWriteTargets('echo x > ~/a', { cwd: '/w' })).toEqual([null])
  expect(listWriteTargets('echo x > /dev/null 2>/dev/stderr', context)).toEqual([])
  expect(listWriteTargets("cat <<'EOF' > out.txt\necho x > inner.txt\nEOF", context)).toEqual(['/w/out.txt'])
})

test('hasExactSegment matches only a segment that is exactly the verify command', () => {
  expect(hasExactSegment('./test/run.sh', './test/run.sh')).toBe(true)
  expect(hasExactSegment('cd x && ./test/run.sh', './test/run.sh')).toBe(true)
  expect(hasExactSegment('./test/run.sh | tail', './test/run.sh')).toBe(false)
  expect(hasExactSegment('./test/run.sh --fast', './test/run.sh')).toBe(false)
})

test('findRanCommands finds a command behind a prefix, in sh -c, eval and substitutions, with its arguments', () => {
  expect(findRanCommands('sudo gh pr create --body x', 'gh pr (?:create|edit)')).toEqual([{ isParsed: true, args: ['--body', 'x'], vars: {}, directory: null }])
  expect(findRanCommands("sh -c 'gh pr edit 5'", 'gh pr (?:create|edit)')).toEqual([{ isParsed: true, args: ['5'], vars: {}, directory: null }])
  expect(findRanCommands("eval 'gh issue create'", 'gh issue create')).toEqual([{ isParsed: true, args: [], vars: {}, directory: null }])
  expect(findRanCommands('echo "$(/usr/bin/gh pr merge 3)"', 'gh pr merge')).toEqual([{ isParsed: true, args: ['3'], vars: {}, directory: null }])
})

test('findRanCommands ignores quoted text and heredoc bodies', () => {
  expect(findRanCommands("git commit -m 'gh pr edit 5'", 'gh pr (?:create|edit)')).toEqual([])
  expect(findRanCommands('cat <<EOF\ngh pr create\nEOF', 'gh pr (?:create|edit)')).toEqual([])
})

test('findRanCommands carries variables only from all-assignment segments before the command', () => {
  const [run] = findRanCommands('cd sub; F=/tmp/b; G=x gh pr edit 5 --body-file "$F"', 'gh pr edit')
  expect(run).toEqual({ isParsed: true, args: ['5', '--body-file', '$F'], vars: { F: '/tmp/b' }, directory: null })
})

test('findRanCommands gives the directory a command runs in, and substitutes a literal assignment opening the line', () => {
  const [run] = findRanCommands('F=/tmp/b; cd sub && gh pr edit 5 --body-file "$F"', 'gh pr edit', context)
  expect(run).toEqual({ isParsed: true, args: ['5', '--body-file', '/tmp/b'], vars: { F: '/tmp/b' }, directory: '/w/sub' })
})

test('listWriteTargets substitutes the literal value an assignment opening the line gives a variable', () => {
  expect(listWriteTargets('S=/tmp/s; rm -rf $S/mod && mkdir -p $S/mod && cp -a /w/m/. $S/mod/', context)).toEqual(['/tmp/s/mod'])
  expect(listWriteTargets('export S=/tmp/s && A="sub" && echo x > "${S}/a" && cd $A && echo y > b', context)).toEqual(['/tmp/s/a', '/w/sub/b'])
  expect(listWriteTargets('S=/tmp/s; S=src; echo x > $S/a', context)).toEqual(['/w/src/a'])
})

test('listWriteTargets leaves a variable unresolved where its value is not that literal assignment for the whole line', () => {
  // The value is no literal, the assignment comes after a command, prefixes only its command, or is followed by a pipe.
  expect(listWriteTargets('S=$(pwd); echo x > $S/a', context)).toEqual([null])
  expect(listWriteTargets('cd /tmp; S=/tmp/s; echo x > $S/a', context)).toEqual([null])
  expect(listWriteTargets('S=/tmp/s echo x > $S/a', context)).toEqual([null])
  expect(listWriteTargets('S=/tmp/s | echo x > $S/a', context)).toEqual([null])
  // The rest of the line assigns it again, reads it, or loops over it.
  expect(listWriteTargets('S=/tmp/s; cd /tmp; S=src; echo x > $S/a', context)).toEqual([null])
  expect(listWriteTargets('S=/tmp/s; read S; echo x > $S/a', context)).toEqual([null])
  expect(listWriteTargets('S=/tmp/s; for S in a b; do echo x > $S; done', context)).toEqual([null])
  // A single-quoted reference is literal text, and a line with a heredoc is left as written.
  expect(listWriteTargets("S=/tmp/s; echo x > '$S'", context)).toEqual([null])
  expect(listWriteTargets('S=/tmp/s; cat <<EOF > $S/a\nx\nEOF', context)).toEqual([null])
})

test('findRanCommands falls back to the whole line when it cannot be parsed', () => {
  expect(findRanCommands('gh pr create --body "open', 'gh pr create')).toEqual([{ isParsed: false }])
  expect(findRanCommands('echo "open', 'gh pr create')).toEqual([])
})
