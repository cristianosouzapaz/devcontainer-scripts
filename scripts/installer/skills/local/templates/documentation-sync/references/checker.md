# The checker

`scripts/check.py` is not a second rule set. It mechanizes the part of the six rules a machine
can settle, so judgment goes where no pattern reaches: altitude, verifiability, authorship and
single source.

## Running it

Run it **from the project root**, naming the script through this skill's base directory
(reported when the skill loads). Page arguments, configuration and index discovery all resolve
against the project root, so a different working directory finds no index.

```
python3 <skill-dir>/scripts/check.py <page>...   # the pages a change touched
python3 <skill-dir>/scripts/check.py --all       # the tree, the README, plus reachability
python3 <skill-dir>/scripts/check.py --all --strict   # warnings are fatal too (CI)
```

It needs `python3` on PATH and nothing else. Git is optional: without it the growth check is
skipped and everything else still runs.

## What it checks

| Check | Severity | What to do with a finding |
| ----- | -------- | ------------------------- |
| Link resolves | ERROR | Fix the path, or remove the link |
| Anchor resolves | ERROR | The heading was renamed or removed — repoint the fragment |
| Repository path exists | ERROR | A path named in inline code is stale; correct it against the code |
| Reachable from the index | ERROR | Link the page from the index, or delete it |
| Frontmatter | ERROR | Matches the project's declared convention; configure it, never work around it |
| Past the hard line limit | ERROR | The page is two pages — split it |
| Reproduces a value | WARN | Decide: input contract, so keep it; shipped default, so cut it — in a code block, the same question decides whether the example earns its place |
| Title joins two concepts | WARN | Split the page, or rename the title to the one concept it owns |
| Over the length guideline | WARN | Acceptable with a reason; otherwise raise the altitude |
| Page grew | WARN | State out loud why the page had to get longer, or generalize existing wording instead |

**ERROR** is objectively broken and must be fixed — a nonzero exit. **WARN** is an indicator
that needs a decision, not a defect. Never silence one by rewording the line into a shape the
checker misses: the finding is about the claim, not the phrasing.

Identifiers in `SCREAMING_SNAKE_CASE` are exempt from the reproduced-value warning, since by
convention those are env vars the reader sets. That keeps the warning rare enough to be worth
reading rather than skimming.

Two limits worth knowing. A path whose top-level directory does not exist at all is not
resolved, so that a reference that merely looks like a path is never reported as stale —
those stay with the reader. And nothing here judges whether a claim is *true*, only whether
what it names still exists.

## Configuring it for the project

Defaults assume a wiki whose pages carry no frontmatter and whose navigation is a link graph
rooted at an index. A project that works differently declares it once in
`.documentation-sync.json` at the project root, rather than living with findings it can never
act on:

| Key | Default | Meaning |
| --- | ------- | ------- |
| `index` | discovered | The documentation index, when it is not in a conventional location |
| `frontmatter` | `"forbidden"` | `"allowed"` for a static-site generator, `"required"` where every page must carry it |
| `reachability` | `true` | `false` where navigation is generated from a config file instead of an index |
| `maxLines` / `hardMaxLines` | `400` / `800` | The length guideline and the hard stop |
| `ignore` | `[]` | Globs for vendored, generated or third-party trees |

An unknown key or a malformed value aborts the run: a setting that is silently ignored looks
exactly like a check that passed.
