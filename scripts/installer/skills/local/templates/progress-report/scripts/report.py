#!/usr/bin/env python3
"""Compute the deterministic part of a progress report and print it as JSON.

Usage: report.py [#n | roadmap]

Reads only public interfaces: the tracker through `gh`, git, and the herdr CLI JSON when herdr
is installed. Issues no write. Every rule the report applies lives here, so two runs on the same
data print the same JSON; the agent only adds the wording.
"""

import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

DONE = ("✅", "Done")
BROKEN = ("🔴", "Broken")
WAITING_ON_YOU = ("🟠", "Waiting on you")
INTEGRATED = ("🟢", "Integrated")
WAITING = ("🟡", "Waiting")
IN_PROGRESS = ("🔵", "In progress")
NOT_STARTED = ("⚪", "Not started")
UNKNOWN = ("?", "?")

NEXT_WORDS = {BROKEN[1], IN_PROGRESS[1], NOT_STARTED[1]}
FAILING = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}
ISSUE_FIELDS = "number,title,body,state,stateReason,labels,parent,subIssues,blockedBy,closedByPullRequestsReferences"


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


def gh_json(*args):
    return json.loads(run(["gh", *args]))


def nodes(value):
    """Returns the items of a gh connection, given either as a list or as {nodes: [...]}."""
    if isinstance(value, dict):
        return value.get("nodes") or []
    return value or []


class Sources:
    """The three public sources, each read lazily and remembered as readable or not."""

    def __init__(self):
        self.unreadable = []
        self.issues = {}
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
            self.issues[number] = gh_json("issue", "view", str(number), "--json", ISSUE_FIELDS)
        return self.issues[number]

    def pr(self, number):
        if number not in self.prs:
            self.prs[number] = gh_json(
                "pr", "view", str(number), "--json",
                "number,state,isDraft,headRefName,baseRefName,statusCheckRollup",
            )
        return self.prs[number]

    def linked_branches(self, number):
        """Branches the issue's Development links list (`gh issue develop --list`, a read)."""
        try:
            out = run(["gh", "issue", "develop", "--list", str(number)])
        except Unreadable as error:
            if "no linked branches" in str(error).lower():
                return []
            raise
        return [line.split("\t")[0].strip() for line in out.splitlines() if line.strip()]

    def prs_for_head(self, branch):
        return [p["number"] for p in gh_json("pr", "list", "--head", branch, "--state", "all", "--json", "number")]

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
    def issue_branches(self):
        """Mapped branches with at least one commit ahead of the default branch; None when unknown."""
        if self._issue_branches is None:
            if self.branches is None or not self.src.git_ok:
                return None
            self._issue_branches = [b for b in self.branches if self.src.ahead(b)]
        return self._issue_branches

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
            return None, "git"
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
        theirs = Issue(src, parent["number"]).issue_branches
        if mine is None or theirs is None:
            return None, "git"
        if not mine or not theirs:
            return False, ""
        into = []
        for branch in mine:
            target = next((t for t in theirs if src.is_ancestor(branch, t)), None)
            if target is None:
                return False, ""
            if target not in into:
                into.append(target)
        names = ", ".join(f"`{t}`" for t in into)
        return True, f"merged into {names}; closes with #{parent['number']}'s PR"

    def rule_waiting():
        blockers = [f"#{b['number']}" for b in nodes(issue.data.get("blockedBy")) if b.get("state") == "OPEN"]
        return bool(blockers), f"blocked by {', '.join(blockers)}"

    def rule_in_progress():
        unit = issue.unit
        if isinstance(unit, dict):
            return True, f"live unit in pane {unit['pane']}"
        branches = issue.issue_branches
        if branches:
            return True, f"commits on {', '.join(f'`{b}`' for b in branches)}"
        if branches is None:
            return None, "git"
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
        return {"icon": UNKNOWN[0], "word": UNKNOWN[1], "reason": f"unreadable: {', '.join(unknown)}"}
    return {"icon": NOT_STARTED[0], "word": NOT_STARTED[1], "reason": "no branch, unit or PR"}


def unit_cell(issue):
    unit = issue.unit
    if isinstance(unit, dict):
        return f"{unit['workspace']} (pane {unit['pane']})"
    if unit == "?":
        return "?"
    if issue.branches:
        return ", ".join(f"`{b}`" for b in issue.branches)
    if issue.prs:
        return ", ".join(f"PR #{n}" for n in issue.prs)
    if issue.branches is None:
        return "?"
    return "none"


def row(src, number, depth):
    issue = Issue(src, number)
    state = decide(issue, src)
    unit = issue.unit
    actions = []
    if state["word"] == WAITING_ON_YOU[1]:
        actions += [
            f"merge PR #{p['number']}"
            for p in issue.open_prs()
            if not p.get("isDraft") and p.get("baseRefName") == src.default_branch
        ]
        if "needs-info" in issue.labels:
            actions.append("give the information asked")
        if "ready-for-human" in issue.labels:
            actions.append("make the choice the issue asks for")
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
        "actions": actions,
        "delegated_review": "delegated-review" in issue.labels,
    }


def tree(src, number, depth=0):
    """The issue, then all its descendants depth-first, in native sub-issue order."""
    rows = [(number, depth)]
    for child in nodes(src.issue(number).get("subIssues")):
        rows += tree(src, child["number"], depth + 1)
    return rows


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
    if argument == "roadmap":
        return {"kind": "roadmap", "issue": roadmap}, [(c["number"], 0) for c in children]
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
        rows = [row(src, number, depth) for number, depth in numbers]
    except (Unreadable, ValueError, KeyError) as error:
        src.mark("gh")
        report["error"] = str(error)
        scope, rows = None, []
    report["scope"] = scope
    report["rows"] = rows
    report["unreadable"] = src.unreadable
    report["next"] = [r["number"] for r in rows if r["state"]["word"] in NEXT_WORDS]
    report["waiting_on_you"]["blocking"] = [
        {"number": r["number"], "actions": r["actions"]} for r in rows if r["state"]["word"] == WAITING_ON_YOU[1]
    ]
    report["waiting_on_you"]["non_blocking_reviews"] = [
        {"number": r["number"], "actions": ["review the delegated decisions"]} for r in rows if r["delegated_review"]
    ]
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
