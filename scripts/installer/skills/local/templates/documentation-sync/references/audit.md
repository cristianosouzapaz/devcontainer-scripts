# Audit mode

A full review of the documentation tree and the README, reported before anything is edited.
Runs only on an explicit `/documentation-sync audit`.

1. **Scope** — every page in the documentation tree (walk out from the index) plus the README.
   Ignore vendored and generated trees.
2. **Run [the checker](checker.md)** over the whole tree with `--all`. Its output is input to
   the report, not the report itself.
3. **Check** — for each page, evaluate the six judgment rules against the actual code rather
   than from memory. With three or more independent pages, fan the per-page checks out to
   parallel subagents in one wave; see the prompt contract below.
4. **Cross-page pass** — Single source cannot be judged one page at a time. After every
   subagent has returned, compare their findings for the same fact stated on two pages, and
   decide which page owns it. This step stays with you; a per-page reviewer cannot see it.
5. **Report** — one table, pages as rows and the six rules as columns. Then number each
   finding with its proposed fix. Make no edits yet.
6. **Confirm** — if anything is `WARN` or `FAIL`, ask which findings to fix: all, a subset, or
   none. "None" ends the run as a report only.
7. **Fix and re-verify** — apply the approved fixes, re-run the checker, and confirm every
   link and anchor still resolves.
8. **Final report** — the updated table, plus a short list of what changed and what was
   deferred. If step 5 found nothing, say so and stop.

## Report format

Status tokens, not symbols or emoji: `PASS`, `WARN` for borderline, `FAIL` for a violation,
and `n/a` where a rule does not apply to that page. They read the same in a terminal, a diff
and a pull request, and they match the severities the checker prints.

| Page | Consistency | Verifiability | Altitude | No mirroring | Single source | Atomic |
| ---- | ----------- | ------------- | -------- | ------------ | ------------- | ------ |

The first two columns are the ones reviewers merge by mistake. Consistency asks whether a
claim *matches* the code. Verifiability asks whether anything could ever settle it: a claim
about a third party's behavior fails here even when it happens to be true today.

List the checker's findings in their own section below the table — they are mechanical
results, not judgments, and mixing them in hides which column a reader has to argue with.

Then, for every `WARN` and `FAIL`, one numbered entry: the page and line, the claim at fault,
which rule it breaks, and the proposed fix. A finding without a proposed fix is an opinion. One
sentence can break two rules at once — cite both in the entry, and score the table cell of the
more severe one.

## Claims that reach outside the tree

A defective claim often has copies beyond the pages under audit: an instruction file agents
load as authoritative, a module's own header comment, a subdirectory README. Report those in a
section of their own and never correct them silently — they are outside the audit's scope, and
the copy an agent reads as an instruction usually does more damage than the page does.

## Subagent prompt contract

A subagent remembers nothing and infers the altitude bar from nothing. Every prompt must:

- name the exact pages it owns, and state that it is **read-only** — it reports, it does not
  edit;
- give the absolute paths of this skill's `SKILL.md` and `references/principles.md`, and
  require reading both before judging anything. Do not paraphrase the bar into the prompt: a
  reviewer working from a summary invents its own;
- require every claim to be verified against the code, naming the file it was checked against;
- fix the output format: one row per page in the table above, plus numbered findings with
  proposed fixes;
- state what is out of scope — Single source across pages, and any edit at all.

Wait for every subagent before synthesizing. Acting on one slice's findings while others are
still running produces fixes that the next result contradicts.
