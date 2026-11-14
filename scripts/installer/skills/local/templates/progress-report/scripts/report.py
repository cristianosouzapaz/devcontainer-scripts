#!/usr/bin/env python3
"""Compute the deterministic part of a progress report and print it as JSON.

Usage: report.py [#n | roadmap]

Reads only public interfaces: the tracker through `gh`, git, and the herdr CLI JSON when herdr
is installed. Issues no write. Every rule the report applies lives here, so two runs on the same
data print the same JSON; the agent only adds the wording.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from concurrent.futures import CancelledError, ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Event

DONE = ("✅", "Done")
BROKEN = ("🔴", "Broken")
WAITING_ON_YOU = ("🟠", "Waiting on you")
INTEGRATED = ("🟢", "Integrated")
PART_OF = ("↳", "Part of")
WAITING = ("🟡", "Waiting")
IN_PROGRESS = ("🔵", "In progress")
NOT_STARTED = ("⚪", "Not started")
UNKNOWN = ("?", "?")

NEXT_WORDS = {BROKEN[1], IN_PROGRESS[1], NOT_STARTED[1]}
FAILING = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}
ISSUE_FIELDS = "number,title,body,state,stateReason,labels,parent,subIssues,blockedBy,closedByPullRequestsReferences"
CREATED = "branch: Created from "
# why: a "?" whose reads all succeeded says so, unlike "unreadable: <source>"
UNVERIFIED = "Unverified:"
# why: these reflog entries only add the branch's own work; fast-forwards, resets, rebases and pulls can import foreign commits
OWN_ENTRIES = ("commit: ", "commit (amend): ", "commit (merge): ", "commit (initial): ", "cherry-pick: ", "revert: ", "Branch: renamed ")
TRUE_MERGE = re.compile(r"merge .+: Merge made by ")


class Unreadable(Exception):
    """A source could not be read."""


def run(argv):
    """Runs a read-only command and returns its stdout, raising Unreadable on any failure."""
    try:
        done = subprocess.run(argv, capture_output=True, text=True, check=False)
    except OSError as error:
        raise Unreadable(str(error)) from error
    if done.returncode != 0:
        raise Unreadable(done.stderr.strip())
    return done.stdout


# why: only these failures pass on their own; a 404, an auth error or a bad query fails the same way again
TRANSIENT = re.compile(r"i/o timeout|connection reset|connection refused|TLS handshake timeout|unexpected EOF|: EOF$|HTTP (?:5\d\d|429)\b", re.I | re.M)
# why: a 4xx other than 429 is the request's own fault, even when its text mentions a timeout
PERMANENT = re.compile(r"HTTP 4(?!29)\d\d\b")


def gh(*args):
    """A read-only gh command's output: the prefetched result when there is one, else read now."""
    out = PREFETCH.take(args)
    return read_gh(*args) if out is SKIPPED else out


def read_gh(*args):
    """Runs a read-only gh command, retrying transient failures; the Unreadable it raises carries `why`."""
    timeout = float(os.environ.get("PROGRESS_REPORT_GH_TIMEOUT", "30"))
    waits = [float(w) for w in os.environ.get("PROGRESS_REPORT_GH_WAITS", "1,3").split(",")]
    for attempt in range(1, len(waits) + 2):
        try:
            # why: gh can spawn helpers (credential helpers, pagers) that keep the pipes open, so a timeout kills its whole group
            with subprocess.Popen(["gh", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True) as proc:
                try:
                    out, err = proc.communicate(timeout=timeout)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.communicate()
                    out, err = None, None
        except OSError as error:
            raise Unreadable(str(error)) from error
        if out is None:
            message, cause = "", f"timed out after {timeout:g} s"
        else:
            if proc.returncode == 0:
                return out
            message = err.strip()
            match = None if PERMANENT.search(message) else TRANSIENT.search(message)
            first = next((line.strip() for line in message.splitlines() if line.strip()), f"exit {proc.returncode}")
            cause = match.group(0) if match else first
            if not match:
                break
        if attempt <= len(waits):
            time.sleep(waits[attempt - 1])
    error = Unreadable(message or cause)
    error.why = f"{cause}, {attempt} attempt{'s' if attempt > 1 else ''}"
    raise error


def gh_json(*args):
    return json.loads(gh(*args))


SKIPPED = object()


class Prefetch:
    """Starts gh reads ahead on a thread pool. The sequential code still asks for each read in its own
    order through gh(), so what it marks and which failure it meets first are unchanged."""

    def __init__(self, jobs):
        # why: about 6 concurrent reads stay clear of GitHub's secondary rate limits; 1 reads sequentially
        self.pool = ThreadPoolExecutor(jobs) if jobs > 1 else None
        # why: keyed by future, so a read asked for twice runs once; only the main thread reads or writes it
        self.futures = {}
        self.failed = Event()

    def ahead(self, argvs):
        for args in argvs:
            if self.pool is None or self.failed.is_set():
                return
            if args not in self.futures:
                try:
                    self.futures[args] = self.pool.submit(self._read, args)
                except RuntimeError:
                    return

    def _read(self, args):
        try:
            return read_gh(*args)
        except Unreadable as error:
            if "no linked branches" not in str(error).lower():
                # why: in an outage every queued read would wait out its own retries; the sequential code makes the later reads itself
                self.failed.set()
                self.pool.shutdown(wait=False, cancel_futures=True)
            raise

    def take(self, args):
        """The read's output, its Unreadable raised again, or SKIPPED when it was never read ahead."""
        future = self.futures.get(args)
        try:
            return SKIPPED if future is None else future.result()
        except CancelledError:
            return SKIPPED

    def peek(self, args):
        """The read's JSON when it was read ahead and succeeded, else None; marks nothing."""
        try:
            out = self.take(args)
            return None if out is SKIPPED else json.loads(out)
        except (Unreadable, ValueError):
            return None

    def close(self):
        if self.pool is not None:
            self.pool.shutdown(wait=False, cancel_futures=True)


PREFETCH = Prefetch(int(os.environ.get("PROGRESS_REPORT_GH_JOBS", "6")))


def issue_view(number):
    return ("issue", "view", str(number), "--json", ISSUE_FIELDS)


def pr_view(number):
    return ("pr", "view", str(number), "--json", "number,state,isDraft,headRefName,baseRefName,statusCheckRollup")


def develop_list(number):
    return ("issue", "develop", "--list", str(number))


def head_prs(branch):
    return ("pr", "list", "--head", branch, "--state", "all", "--json", "number")


def prefetch_tree(number):
    """Reads the tree's issues ahead, a level at a time."""
    level = [number]
    while level:
        PREFETCH.ahead([issue_view(n) for n in level])
        level = [c["number"] for n in level for c in nodes((PREFETCH.peek(issue_view(n)) or {}).get("subIssues"))]


def prefetch_rows(src, numbers):
    """Reads ahead each row's Development links and closing PRs, then those of the parents and blockers
    the rules read, then the head PRs of name-matched branches for issues with neither."""
    seen, todo = [], list(dict.fromkeys(numbers))
    for _ in range(2):
        PREFETCH.ahead([issue_view(n) for n in todo])
        data = {n: PREFETCH.peek(issue_view(n)) or {} for n in todo}
        PREFETCH.ahead([develop_list(n) for n in todo])
        PREFETCH.ahead([pr_view(p["number"]) for d in data.values() for p in nodes(d.get("closedByPullRequestsReferences"))])
        seen += todo
        related = [(d.get("parent") or {}).get("number") for d in data.values()]
        related += [b["number"] for d in data.values() for b in nodes(d.get("blockedBy"))]
        todo = [n for n in dict.fromkeys(related) if n and n not in seen]
    if not src.git_ok:
        return
    names = None
    for number in seen:
        data = PREFETCH.peek(issue_view(number))
        if not data or nodes(data.get("closedByPullRequestsReferences")):
            continue
        try:
            out = PREFETCH.take(develop_list(number))
        except Unreadable as error:
            out = "" if "no linked branches" in str(error).lower() else SKIPPED
        if out is SKIPPED or out.strip():
            continue
        try:
            names = src.branch_names() if names is None else names
        except Unreadable:
            return
        PREFETCH.ahead([head_prs(b) for b in names if token_match(b, number)])


def nodes(value):
    """Returns the items of a gh connection, given either as a list or as {nodes: [...]}."""
    if isinstance(value, dict):
        return value.get("nodes") or []
    return value or []


def truncated(value):
    """True when a gh connection returned fewer nodes than its totalCount."""
    return isinstance(value, dict) and (value.get("totalCount") or 0) > len(nodes(value))


class Sources:
    """The three public sources, each read lazily and remembered as readable or not."""

    def __init__(self):
        self.unreadable = []
        self.issues = {}
        self.objects = {}
        self.states = {}
        self.prs = {}
        self.branch_checks = {}
        self.default_branch = None
        self.git_ok = self._probe_git()
        self.herdr_present = shutil.which("herdr") is not None
        self.units = self._read_herdr() if self.herdr_present else {}

    def mark(self, name):
        if name not in self.unreadable:
            self.unreadable.append(name)

    # ----- gh -----

    def issue(self, number):
        if number not in self.issues:
            data = gh_json(*issue_view(number))
            for field in ("subIssues", "blockedBy"):
                if truncated(data.get(field)):
                    self.mark(f"gh (truncated {field} of #{number})")
            self.issues[number] = data
        return self.issues[number]

    def get(self, number):
        """The Issue for a number, built once per run."""
        if number not in self.objects:
            self.objects[number] = Issue(self, number)
        return self.objects[number]

    def state(self, number):
        """The issue's state, decided once per run."""
        if number not in self.states:
            self.states[number] = decide(self.get(number), self)
        return self.states[number]

    def pr(self, number):
        if number not in self.prs:
            self.prs[number] = gh_json(*pr_view(number))
        return self.prs[number]

    def linked_branches(self, number):
        """Branches the issue's Development links list (`gh issue develop --list`, a read)."""
        try:
            out = gh(*develop_list(number))
        except Unreadable as error:
            if "no linked branches" in str(error).lower():
                return []
            raise
        return [line.split("\t")[0].strip() for line in out.splitlines() if line.strip()]

    def prs_for_head(self, branch):
        return [p["number"] for p in gh_json(*head_prs(branch))]

    def remote_branch_failing(self, branch):
        """True when a check run on the branch's pushed head failed; False when the branch is not pushed."""
        if branch in self.branch_checks:
            return self.branch_checks[branch]
        result = False
        if self.git_ref(f"refs/remotes/origin/{branch}"):
            try:
                sha = run(["git", "rev-parse", f"refs/remotes/origin/{branch}"]).strip()
                data = gh_json("api", f"repos/{{owner}}/{{repo}}/commits/{sha}/check-runs?per_page=100")
                result = any((run_.get("conclusion") or "").upper() in FAILING for run_ in data.get("check_runs", []))
            except (Unreadable, ValueError):
                self.mark("gh (branch checks)")
                result = None
        self.branch_checks[branch] = result
        return result

    # ----- git -----

    def _probe_git(self):
        try:
            run(["git", "rev-parse", "--git-dir"])
            return True
        except Unreadable:
            self.mark("git")
            return False

    def git_ref(self, ref):
        try:
            run(["git", "rev-parse", "--verify", "--quiet", ref])
            return True
        except Unreadable:
            return False

    def branch_names(self):
        out = run(["git", "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"])
        names = []
        for ref in out.split():
            name = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref[len("refs/remotes/origin/"):]
            if name != "HEAD" and name not in names:
                names.append(name)
        return names

    def resolve(self, branch):
        """The ref a branch name points at: the local branch first, else origin's."""
        for ref in (f"refs/heads/{branch}", f"refs/remotes/origin/{branch}"):
            if self.git_ref(ref):
                return ref
        return None

    def default_ref(self):
        return self.resolve(self.default_branch)

    def ahead(self, branch):
        """True when the branch has at least one commit the default branch lacks."""
        ref, base = self.resolve(branch), self.default_ref()
        if ref is None or base is None:
            return False
        return int(run(["git", "rev-list", "--count", f"{base}..{ref}"]).strip()) > 0

    def creation(self, branch):
        """(commit, why): the commit the branch was created at when its reflog proves it, else None and
        what happened to the branch, worded to follow "branch `x`".

        Proven only when the oldest entry creates the branch from something other than a remote ref,
        and every later entry is one that cannot bring in commits made elsewhere.
        """
        try:
            out = run(["git", "reflog", "show", "--format=%H %gs", self.resolve(branch), "--"])
        except Unreadable:
            return None, "has no creation record"
        lines = out.strip().splitlines()[::-1]
        if not lines:
            return None, "has no creation record"
        sha, _, subject = lines[0].partition(" ")
        if not subject.startswith(CREATED):
            return None, "has no creation record"
        source = subject[len(CREATED):]
        if source.startswith(("origin/", "refs/remotes/")):
            return None, f"was created from `{source}`"
        for line in lines[1:]:
            subject = line.partition(" ")[2]
            if not (subject.startswith(OWN_ENTRIES) or TRUE_MERGE.match(subject)):
                return None, imported(subject)
        return sha, None

    def own_work(self, branch):
        """(own, why): whether the branch has work of its own, and why that is unproven (None when proven).

        Its own work is the non-merge first-parent history since the proven creation point. With none
        (an origin-only branch, an expired reflog, a fast-forward, reset or rebase since creation) the
        history ahead of the default branch stands in, unproven.
        """
        created, why = self.creation(branch)
        if created is None:
            return self.ahead(branch), why
        count = run(["git", "rev-list", "--count", "--first-parent", "--no-merges", f"{created}..{self.resolve(branch)}"])
        return int(count.strip()) > 0, None

    def is_ancestor(self, branch, other):
        try:
            run(["git", "merge-base", "--is-ancestor", self.resolve(branch), self.resolve(other)])
            return True
        except Unreadable:
            return False

    # ----- herdr -----

    def _read_herdr(self):
        """Maps each worktree branch with an open workspace to its live unit, the first agent pane in it."""
        try:
            worktrees = json.loads(run(["herdr", "worktree", "list"]))["result"]["worktrees"]
            panes = json.loads(run(["herdr", "pane", "list"]))["result"]["panes"]
        except (Unreadable, ValueError, KeyError, TypeError):
            self.mark("herdr")
            return None
        units = {}
        for tree in worktrees:
            workspace = tree.get("open_workspace_id")
            if not workspace or not tree.get("branch"):
                continue
            pane = next((p for p in panes if p.get("workspace_id") == workspace and p.get("agent")), None)
            if pane:
                units[tree["branch"]] = {"workspace": workspace, "pane": pane["pane_id"], "branch": tree["branch"]}
        return units


def imported(subject):
    """What a reflog entry that can import foreign commits did, worded to follow "branch `x`"."""
    fast_forward = re.match(r"merge (.+): Fast-forward", subject)
    if fast_forward:
        return f"took in other commits by a fast-forward from `{fast_forward.group(1)}`"
    if subject.startswith("pull"):
        return "took in other commits by a pull"
    reset = re.match(r"(?:reset: moving to|branch: Reset to) (.+)", subject)
    if reset:
        return f"was reset to `{reset.group(1)}`"
    if subject.startswith("rebase"):
        return "was rebased"
    if not subject:
        return "was moved by an update that left no reflog message"
    return f"was moved by `{subject}`"


def token_match(branch, number):
    """The issue number appears in the branch name as a whole token."""
    return re.search(rf"(?:^|[/-]){number}(?:-|$)", branch) is not None


class Issue:
    """One issue with the evidence the state rules read; a field is None when its source is unreadable."""

    def __init__(self, src, number):
        self.src = src
        self.data = src.issue(number)
        self.number = number
        self.open = self.data["state"] == "OPEN"
        self.labels = [label["name"] for label in self.data.get("labels") or []]
        self._branches = self._prs = self._issue_branches = None
        self._mapped = False
        self.links_failed = False
        # why: maps each existing branch to why its own work is unproven, None when proven
        self.unproven = {}
        self.integrated_into = []

    def _map(self):
        """Issue → branches / PRs: explicit links first, else whole-token branch name matches."""
        if self._mapped:
            return
        self._mapped = True
        src = self.src
        prs = [p["number"] for p in nodes(self.data.get("closedByPullRequestsReferences"))]
        try:
            branches = src.linked_branches(self.number)
        except Unreadable:
            src.mark("gh (development links)")
            self.links_failed = True
            branches = None
        if branches is not None:
            for number in prs:
                head = src.pr(number)["headRefName"]
                if head not in branches:
                    branches.append(head)
        if branches == [] and not prs:
            if not src.git_ok:
                branches = None
            else:
                branches = [b for b in src.branch_names() if token_match(b, self.number)]
                for branch in branches:
                    prs += [n for n in src.prs_for_head(branch) if n not in prs]
        self._branches, self._prs = branches, prs

    @property
    def branches(self):
        self._map()
        return self._branches

    @property
    def prs(self):
        self._map()
        return self._prs

    @property
    def why_unknown(self):
        """The source that left the branches unknown."""
        self._map()
        return "gh (development links)" if self.links_failed else "git"

    @property
    def existing_branches(self):
        """Mapped branches that resolve locally or at origin."""
        if not self.src.git_ok:
            return []
        return [b for b in self.branches or [] if self.src.resolve(b)]

    @property
    def issue_branches(self):
        """Existing branches with work of their own (see Sources.own_work); None when unknown."""
        if self._issue_branches is None:
            if self.branches is None or not self.src.git_ok:
                return None
            mine = []
            for branch in self.existing_branches:
                own, self.unproven[branch] = self.src.own_work(branch)
                if own:
                    mine.append(branch)
            self._issue_branches = mine
        return self._issue_branches

    @property
    def proven_branches(self):
        """Existing branches whose creation point is proven, with or without work of their own; None
        when any existing branch is unproven or the branches are unknown."""
        if self.issue_branches is None or any(self.unproven.values()):
            return None
        return self.existing_branches

    @property
    def fresh_branches(self):
        """Existing branches with no work of their own."""
        return [b for b in self.existing_branches if b not in (self.issue_branches or [])]

    @property
    def unit(self):
        if self.src.units is None:
            return None if not self.src.herdr_present else "?"
        for branch in self.branches or []:
            if branch in self.src.units:
                return self.src.units[branch]
        return None

    def open_prs(self):
        return [self.src.pr(n) for n in self.prs or [] if self.src.pr(n)["state"] == "OPEN"]

    def actions(self):
        """What the issue waits on the user for, whatever its state."""
        found = [
            f"merge PR #{p['number']}"
            for p in self.open_prs()
            if not p.get("isDraft") and p.get("baseRefName") == self.src.default_branch
        ]
        if "needs-info" in self.labels:
            found.append("give the information asked")
        if "ready-for-human" in self.labels:
            found.append("make the choice the issue asks for")
        return found


def failing(pr):
    for check in pr.get("statusCheckRollup") or []:
        verdict = (check.get("conclusion") or check.get("state") or "").upper()
        if verdict in FAILING:
            return True
    return False


def decide(issue, src):
    """Applies the state rules in order: the first True wins, unless an earlier rule was unknown."""
    unknown = []

    def rule_done():
        reason = (issue.data.get("stateReason") or "completed").lower().replace("_", " ")
        return (not issue.open), reason

    def rule_broken():
        bad = [f"PR #{p['number']}" for p in issue.open_prs() if failing(p)]
        if bad:
            return True, f"failing check on {', '.join(bad)}"
        if issue.issue_branches is None:
            return None, issue.why_unknown
        for branch in issue.issue_branches:
            verdict = src.remote_branch_failing(branch)
            if verdict:
                return True, f"failing check on `{branch}`"
            if verdict is None:
                return None, "gh (branch checks)"
        return False, ""

    def rule_waiting_on_you():
        reasons = [f"label `{label}`" for label in ("ready-for-human", "needs-info") if label in issue.labels]
        reasons += [
            f"PR #{p['number']} awaits your merge"
            for p in issue.open_prs()
            if not p.get("isDraft") and p.get("baseRefName") == src.default_branch
        ]
        return bool(reasons), "; ".join(reasons)

    def rule_integrated():
        parent = issue.data.get("parent")
        if not parent or parent.get("state") != "OPEN":
            return False, ""
        mine = issue.issue_branches
        if mine is None:
            return None, issue.why_unknown
        if not mine:
            return False, ""
        parent_issue = src.get(parent["number"])
        theirs = parent_issue.issue_branches
        if theirs is None:
            return None, parent_issue.why_unknown
        if not theirs:
            return False, ""
        into, target_of = [], {}
        for branch in mine:
            target = next((t for t in theirs if src.is_ancestor(branch, t)), None)
            if target is None:
                return False, ""
            target_of[branch] = target
            if target not in into:
                into.append(target)
        unverified = [
            f"{UNVERIFIED} branch `{b}` {issue.unproven[b]}, so its own work cannot be proven; "
            f"check `git log {target_of[b]}..{b}`"
            for b in mine
            if issue.unproven.get(b)
        ]
        if unverified:
            return None, "; ".join(unverified)
        issue.integrated_into = into
        names = ", ".join(f"`{t}`" for t in into)
        return True, f"merged into {names}; closes with #{parent['number']}'s PR"

    def contained(number):
        """The blocker has issue branches and each is an ancestor of one of this issue's branches, every
        branch on both sides proven. This issue's branches count even with no work of their own: a
        proven fresh branch's tip is its creation base, so ancestry still says what it was cut after."""
        mine = issue.proven_branches
        if not mine:
            return False
        blocker = src.get(number)
        theirs = blocker.issue_branches
        if not theirs or blocker.proven_branches is None:
            return False
        return all(any(src.is_ancestor(b, m) for m in mine) for b in theirs)

    def rule_waiting():
        blockers = [
            f"#{b['number']}"
            for b in nodes(issue.data.get("blockedBy"))
            if b.get("state") == "OPEN" and not contained(b["number"])
        ]
        return bool(blockers), f"blocked by {', '.join(blockers)}"

    def rule_in_progress():
        unit = issue.unit
        if isinstance(unit, dict):
            return True, f"live unit in pane {unit['pane']}"
        branches = issue.issue_branches
        if branches:
            return True, f"commits on {', '.join(f'`{b}`' for b in branches)}"
        if branches is None:
            return None, issue.why_unknown
        if unit == "?":
            return None, "herdr"
        return False, ""

    rules = (
        (DONE, rule_done),
        (BROKEN, rule_broken),
        (WAITING_ON_YOU, rule_waiting_on_you),
        (INTEGRATED, rule_integrated),
        (WAITING, rule_waiting),
        (IN_PROGRESS, rule_in_progress),
    )
    for (icon, word), rule in rules:
        verdict, reason = rule()
        if verdict is None:
            if reason not in unknown:
                unknown.append(reason)
        elif verdict:
            if unknown:
                break
            return {"icon": icon, "word": word, "reason": reason}
    if unknown:
        failed = [r for r in unknown if not r.startswith(UNVERIFIED)]
        parts = ([f"unreadable: {', '.join(failed)}"] if failed else []) + [r for r in unknown if r.startswith(UNVERIFIED)]
        return {"icon": UNKNOWN[0], "word": UNKNOWN[1], "reason": "; ".join(parts)}
    group = group_of(issue, src)
    if group:
        return group
    fresh = issue.fresh_branches
    if fresh:
        names = ", ".join(f"`{b}`" for b in fresh)
        return {"icon": NOT_STARTED[0], "word": NOT_STARTED[1], "reason": f"branch {names}, no commit of its own"}
    return {"icon": NOT_STARTED[0], "word": NOT_STARTED[1], "reason": "no branch, unit or PR"}


def group_of(issue, src):
    """For an issue with no issue branch, unit or PR of its own, the state its open parent's group
    gives it: Part of when the parent is Integrated or itself Part of one, "?" when the parent's
    state is "?"; None otherwise."""
    parent = issue.data.get("parent")
    if not parent or parent.get("state") != "OPEN" or issue.issue_branches or issue.prs:
        return None
    if isinstance(issue.unit, dict):
        return None
    number = parent["number"]
    state = src.state(number)
    if state["word"] == INTEGRATED[1]:
        names = ", ".join(f"`{t}`" for t in src.get(number).integrated_into)
        return {"icon": PART_OF[0], "word": PART_OF[1], "reason": f"#{number} (integrated into {names})"}
    if state["word"] == PART_OF[1]:
        return {"icon": PART_OF[0], "word": PART_OF[1], "reason": state["reason"]}
    if state["word"] == UNKNOWN[1]:
        # why: a failed read stays named as such; only a parent whose reads all succeeded is unverified
        if state["reason"].startswith("unreadable:"):
            return state
        reason = f"{UNVERIFIED} part of #{number}, whose integration cannot be proven"
        return {"icon": UNKNOWN[0], "word": UNKNOWN[1], "reason": reason}
    return None


def unit_cell(issue):
    unit = issue.unit
    if isinstance(unit, dict):
        return f"{unit['workspace']} (pane {unit['pane']})"
    if unit == "?":
        return "?"
    if issue.existing_branches:
        return ", ".join(f"`{b}`" for b in issue.existing_branches)
    if issue.prs:
        return ", ".join(f"PR #{n}" for n in issue.prs)
    if issue.branches is None:
        return "?"
    return "none"


def row(src, number, depth):
    issue = src.get(number)
    state = src.state(number)
    unit = issue.unit
    return {
        "number": number,
        "depth": depth,
        "title": issue.data["title"],
        "body": issue.data.get("body") or "",
        "open": issue.open,
        "labels": issue.labels,
        "branches": "?" if issue.branches is None else issue.branches,
        "issue_branches": "?" if issue.issue_branches is None else issue.issue_branches,
        "prs": issue.prs,
        "unit": unit,
        "unit_cell": unit_cell(issue),
        "state": state,
        "actions": issue.actions() if issue.open else [],
        "delegated_review": "delegated-review" in issue.labels,
    }


def tree(src, number, depth=0):
    """The issue, then all its descendants depth-first, in native sub-issue order."""
    if depth == 0:
        prefetch_tree(number)
    rows = [(number, depth)]
    for child in nodes(src.issue(number).get("subIssues")):
        rows += tree(src, child["number"], depth + 1)
    return rows


def blocker_order(src, numbers):
    """Topological order by native blocked-by within the set: blockers first, ties by issue number, a
    cycle released at its lowest-numbered member; blockers outside the set are ignored."""
    remaining = set(numbers)
    blockers = {n: {b["number"] for b in nodes(src.issue(n).get("blockedBy"))} for n in numbers}

    def on_cycle(start):
        seen, stack = set(), [b for b in blockers[start] if b in remaining]
        while stack:
            node = stack.pop()
            if node == start:
                return True
            if node not in seen:
                seen.add(node)
                stack += [b for b in blockers[node] if b in remaining]
        return False

    order = []
    while remaining:
        free = [n for n in remaining if not blockers[n] & remaining]
        pick = min(free) if free else min(n for n in remaining if on_cycle(n))
        order.append(pick)
        remaining.remove(pick)
    return order


def waiting_on_you(src, scope):
    """The scope issue's and every open descendant's actions and delegated reviews, whatever their
    state, in tree order; "?" for both lists when a sub-issue list in the scope was truncated."""
    if not scope or "issue" not in scope:
        return [], []
    numbers = [n for n, _ in tree(src, scope["issue"])]
    if any(truncated(src.issue(n).get("subIssues")) for n in numbers):
        return "?", "?"
    blocking, reviews = [], []
    for number in numbers:
        issue = src.get(number)
        if not issue.open:
            continue
        actions = issue.actions()
        if actions:
            blocking.append({"number": number, "actions": actions})
        if "delegated-review" in issue.labels:
            reviews.append({"number": number, "actions": ["review the delegated decisions"]})
    return blocking, reviews


def resolve_scope(src, argument):
    """Returns (scope, [(number, depth)]); scope asks the user when the choice is not deterministic."""
    match = re.fullmatch(r"#?(\d+)", argument or "")
    if match:
        number = int(match.group(1))
        return {"kind": "issue", "issue": number}, tree(src, number)
    roadmaps = gh_json("issue", "list", "--label", "roadmap", "--state", "open", "--json", "number,title")
    if not roadmaps:
        return {"kind": "ask", "reason": "no-roadmap", "candidates": []}, []
    if len(roadmaps) > 1:
        return {"kind": "ask", "reason": "several-roadmaps", "candidates": roadmaps}, []
    roadmap = roadmaps[0]["number"]
    children = nodes(src.issue(roadmap).get("subIssues"))
    PREFETCH.ahead([issue_view(c["number"]) for c in children])
    if argument == "roadmap":
        order = blocker_order(src, [c["number"] for c in children])
        return {"kind": "roadmap", "issue": roadmap}, [(n, 0) for n in order]
    current = []
    for child in children:
        if child.get("state") != "OPEN":
            continue
        data = src.issue(child["number"])
        if not any(b.get("state") == "OPEN" for b in nodes(data.get("blockedBy"))):
            current.append({"number": child["number"], "title": data["title"]})
    if len(current) != 1:
        reason = "no-current" if not current else "several-current"
        return {"kind": "ask", "reason": reason, "roadmap": roadmap, "candidates": current}, []
    number = current[0]["number"]
    return {"kind": "current", "roadmap": roadmap, "issue": number}, tree(src, number)


def main(argv):
    if len(argv) > 1 or (argv and not re.fullmatch(r"#?\d+|roadmap", argv[0])):
        print("usage: report.py [#n | roadmap]", file=sys.stderr)
        return 2
    report = {
        "read_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": [],
        "unreadable": [],
        "unit_questions": "not read, no public interface",
        "scope": None,
        "rows": [],
        "next": [],
        "waiting_on_you": {"blocking": [], "non_blocking_reviews": []},
    }
    src = Sources()
    report["sources"] = ["gh", "git"] + (["herdr"] if src.herdr_present else [])
    try:
        src.default_branch = gh_json("repo", "view", "--json", "defaultBranchRef")["defaultBranchRef"]["name"]
        scope, numbers = resolve_scope(src, argv[0] if argv else None)
        prefetch_rows(src, [number for number, _ in numbers])
        rows = [row(src, number, depth) for number, depth in numbers]
        blocking, reviews = waiting_on_you(src, scope)
    except (Unreadable, ValueError, KeyError) as error:
        src.mark(f"gh ({error.why})" if hasattr(error, "why") else "gh")
        report["error"] = str(error)
        scope, rows, blocking, reviews = None, [], [], []
    PREFETCH.close()
    report["scope"] = scope
    report["rows"] = rows
    report["unreadable"] = src.unreadable
    report["next"] = [r["number"] for r in rows if r["state"]["word"] in NEXT_WORDS]
    report["waiting_on_you"] = {"blocking": blocking, "non_blocking_reviews": reviews}
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
