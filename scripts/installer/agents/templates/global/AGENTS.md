# Working Agreement

Personal, machine-wide. Project instructions override anything here.

All artifacts are written in English — issues, pull requests, commits, code,
comments and documentation — whatever language the conversation is held in.

## Where planning lives

Issue tracker: **GitHub Issues**, via the `gh` CLI. Triage labels: `needs-triage`,
`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
If `gh repo view` fails, say so and ask. Never fall back to writing planning
files into the repo.

**Ephemeral goes to the tracker. Durable stays in the repo.** Specs, plans,
ticket lists, design notes and open questions are ephemeral: they exist only to
reach an implementation, and afterwards they are noise. Product documentation,
the wiki, glossaries and decision records are durable: they outlive the work and
stay versioned alongside the code.

## Does this need an issue?

One "yes" is enough.

1. **Is there a decision?** More than one reasonable way to do it, and you are picking one.
2. **Will someone look for it?** A user, a colleague, or you in three months.
3. **Does it outlive one session?** The work has to be paused and resumed.

Renames, mechanical refactors, typos, formatting, version bumps: no issue.
A feature, however small: issue. A reported bug: issue.

## The four flows

**Large feature** — too big for one session, the route is not yet visible.
Chart a map of decision tickets and resolve them one at a time (`wayfinder`),
then split the outcome into tracer-bullet tickets (`to-tickets`).

**Small feature** — fits in one session.
Sharpen the idea by interview (`grilling`), then turn the conversation into a
spec published to the tracker (`to-spec`). Split it into tickets (`to-tickets`)
only when the work has real ordering constraints.

**Fix** — something is broken.
Reproduce and isolate before changing anything (`diagnosing-bugs`). Reports that
arrive raw get sorted first (`triage`).

**Close out** — the work is done.
Write the commits (`generate-commit`), then open the PR (`create-pr`). The PR
body must carry `Closes #<n>` so the tracker does not accumulate finished work.
Branch naming is free.

**One unit of work per session.** When a ticket or a flow completes, say so and
stop. The next unit starts in a fresh session, from its issue. If this session
produced context that no issue captured — a dead end explored, an approach ruled
out, work interrupted mid-way — tell the user to run `/handoff` before clearing.

**Writing code is not a flow, it is a constant.** Whenever code gets written, in
any flow, take the laziest solution that actually works (`ponytail`). A ticket
that is ready goes straight to code — there is no separate build step.

## Toolbox

| Need | Skill |
| --- | --- |
| Stress-test an idea by interview | `grilling` |
| Build vocabulary, glossary, decision records | `domain-modeling` |
| Establish a fact from primary sources | `research` |
| Answer a design question with throwaway code | `prototype` |
| Hand the work to a fresh session | `handoff` |

Anything else installed is a dependency or an alias, not an entry point.
