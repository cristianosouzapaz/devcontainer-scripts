# Installer Tests

## `global-skill-set.test.js`

| Test | Verifies |
| --- | --- |
| returns an empty map when neither ~/.agents nor ~/.claude exists | `readGlobalSkillSet()` never throws on a machine with no shared asset tree |
| reads first-party names and their recorded versions from ~/.agents/template-lock.json | Each `.agents/skills/<name>/SKILL.md` artifact maps to `name → version`; non-skill artifact paths are ignored |
| adds directory entries under ~/.agents/skills and ~/.claude/skills with a null version | A skill known only from a directory (real or symlink) listing is included with a `null` version |
| the lock version wins over a bare directory listing for the same name | A name present in both the lock and a directory listing keeps its recorded version |
| ignores dotfiles and plain files, and tolerates an unreadable lock file | Dotfiles and non-directory entries are skipped; a malformed `template-lock.json` degrades to the directory listings |
| disableGlobalChoices marks only the choices whose key is global, without mutating input | Global keys get a `disabled` copy annotated with the global-install label; other choices and the input array are untouched |
| restoreChecked re-checks prior picks by value reference and leaves disabled rows alone | Choices whose `value` is in the selection get `checked: true`, disabled rows keep their `disabled` label and stay unchecked, and the input array is not mutated |
| restoreChecked treats a missing selection as nothing checked | Called with no selection argument, every choice comes back `checked: false` |

## `global-scope.test.js`

| Test | Verifies |
| --- | --- |
| installGlobal materializes the agents.global.json prompts into ~/.agents with Claude symlinks and a scoped lock | `agents/index.js --global` reads `agents/agents.global.json`, writes canonical `~/.agents/skills/<name>/SKILL.md`, a `../../`-relative Claude skill symlink, and `~/.agents/template-lock.json` (never a bare `~/template-lock.json`) with `kind: "prompt"` and no Copilot adapter |
| installGlobal is idempotent — a second run leaves the tracked artifacts unchanged | Re-running does not change the recorded `artifacts` set |
| agents.global.json only names instruction and prompt skills the installer actually ships | Every name in the manifest's `instructions`/`prompts` arrays resolves to an `instructions.json`/`prompts.json` entry |

## `global-local-skills.test.js`

| Test | Verifies |
| --- | --- |
| installGlobalLocalSkills materializes every skills.global.json key into ~/.agents with a Claude symlink and a scoped lock | `skills/local/index.js --global` reads `skills/local/skills.global.json`, writes canonical `~/.agents/skills/<key>/SKILL.md`, a `../../`-relative Claude skill symlink, and a `kind: "skill"` artifact in `~/.agents/template-lock.json` (never a bare `~/template-lock.json`) with no Copilot adapter |
| installGlobalLocalSkills is idempotent — a second run leaves the tracked artifacts unchanged | Re-running does not change the recorded `artifacts` set |
| skills/local/skills.global.json only names keys the local skills catalog ships | Every key in the manifest resolves to a `skills/local/skills.json` entry |

## `global-skills.test.js`

| Test | Verifies |
| --- | --- |
| loadGlobalSkillsManifest returns the validated third-party skill list | `skills/skills.global.json` parses into a non-empty array of `{ name, url, skill? }` GitHub sources |
| the global skills manifest agrees with the interactive catalog on shared sources | Any `skills.global.json` skill also present in `skills.json` agrees with it on the source URL |
| installGlobalSkills adds every manifest skill globally, then refreshes the store | The `--global` path runs `skills add <url> -g --yes [--skill <name>]` once per manifest entry in order, then a final `skills update -g --yes` |
| installGlobalSkills tolerates a per-skill failure and a failed update | A throwing `skills add` does not abort the loop — every remaining skill is still attempted — and a failing `skills update -g` is swallowed |
| each installer references its global manifest, so the bootstrap graph walk fetches it | `skills/index.js`, `agents/index.js`, and `skills/local/index.js` each name their `*.global.json` via `new URL(...)`, which is how `install.sh` discovers and downloads it |

## `template-lock.test.js`

| Test | Verifies |
| --- | --- |
| Records Claude and Copilot adapters for every generated agent artifact | A v2 lock records canonical instruction and prompt artifacts, their generated Claude symlinks including expected targets, and Copilot adapter files; a removed symlink is pruned during reconciliation |
| Does not create adapters for an unmanaged asset skipped during conflict resolution | Skipping an untracked canonical conflict leaves the asset unrecorded and creates neither Claude nor Copilot adapter |

## `skills-catalog.test.js`

| Test | Verifies |
| --- | --- |
| Groups known categories in the picker order and retains catalog order within each category | The category picker follows its curated display order while skills in one category retain their catalog order |
| Places uncategorized additions after known categories in their first-seen order | A future category is still shown after curated categories without losing its catalog order |
| the skills picker imports the catalog helper, so the bootstrap graph walk fetches it | `skills/index.js` statically imports `./catalog.js`, which is how `install.sh` discovers and downloads it |

## `selection-summary.test.js`

| Test | Verifies |
| --- | --- |
| Formats a compact summary with counted sections | The shared summary uses the standard title, divider, counts, and indented items |
| Omits empty sections | Optional sections with no entries do not add visual noise to the summary |
