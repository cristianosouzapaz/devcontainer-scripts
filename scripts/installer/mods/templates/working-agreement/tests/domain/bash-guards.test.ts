import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { listScriptCandidates } from '../../hooks/domain/bash-guards'
import { noFlow } from '../support/builders'
import { declareFlow } from '../support/helpers'
import { test } from '../support/kit'
import { buildScope, createWorld, markSpawned, records, scopeFile } from '../support/world'
import type { Graph, Options } from '../support/world'

const recordsDeny = 'are written only by the mod'

// why: each of these only reads the records, or writes outside them while naming them: every command is in the table, cp, dd, ln and rsync only read their records operand, and grep's pattern is no command; the raw-line guard refused most, and 3b36ab23 refused the grep rows.
const recordReads = [
  `jq 'select(.at > 5)' ${records}/log/*`,
  `grep -E '^> ' ${records}/log/a.jsonl`,
  `ls ${records}/dd/`,
  `ls ${records}; rm -rf /tmp/x`,
  `ls ${records} >/dev/null`,
  `ls ${records} 2>/dev/null`,
  `jq . ${records}/dd/1.json > /tmp/out.json`,
  `cat > /tmp/x <<'EOF'\nsee ${records}/mail\nEOF`,
  `cp ${records}/dd/1.json /tmp/x`,
  `dd if=${records}/dd/1.json of=/tmp/x`,
  `ln -s ${records}/dd/1.json /tmp/l`,
  `grep git ${records}/x`,
  `grep -l sudo ${records}/mail/a.json`,
  `ls ${records} | grep env`,
  `rsync -a ${records}/x /tmp/y`,
  `sed -n 1,5p ${records}/x`,
  `sed 's/a/b/g' ${records}/x`,
  `sort -t, -k2 ${records}/x`,
]

// why: a quoted `->` or `>` inside a string argument is never a redirection; the base, which read `>` anywhere in the raw line, refused every one.
const quotedArrows = [
  `grep -- '->' ${records}/x`,
  `cat ${records}/x | sed 's/a/->/'`,
  `grep -- 'a > b' ${records}/x`,
  `cat ${records}/x | sed 's/a/>/'`,
]

// why: every one writes under the records through a construct the parser models, behind any wrapper or assignment, so the refusal names the token that writes.
const recordWrites = [
  [`rm ${records}/dd/1.json`, 'rm'],
  [`echo x > ${records}/spawn/3.json`, '>'],
  [`cp /tmp/x ${records}/mail/new/x.1.json`, 'cp'],
  [`cp -t ${records}/mail /tmp/x`, 'cp'],
  [`mv ${records}/dd/1.json /tmp/x`, 'mv'],
  [`ln -s /tmp/x ${records}/l`, 'ln'],
  [`dd if=/tmp/x of=${records}/x`, 'dd'],
  [`echo x 2> ${records}/x`, '2>'],
  [`echo x &> ${records}/x`, '&>'],
  [`echo x >| ${records}/x`, '>|'],
  [`cat <> ${records}/x`, '<>'],
  [`exec 3> ${records}/x`, '3>'],
  [`env rm ${records}/x`, 'rm'],
  [`command rm ${records}/x`, 'rm'],
  [`builtin command rm ${records}/x`, 'rm'],
  [`exec rm ${records}/x`, 'rm'],
  [`nice -n 5 rm ${records}/x`, 'rm'],
  [`nohup rm ${records}/x`, 'rm'],
  [`timeout 5 rm ${records}/x`, 'rm'],
  [`time rm ${records}/x`, 'rm'],
  [`sudo -u root rm ${records}/x`, 'rm'],
  [`doas rm ${records}/x`, 'rm'],
  [`echo x | tee -a ${records}/x`, 'tee'],
  [`cp --target-directory=${records}/ /tmp/x`, 'cp'],
  [`rsync -a /tmp/y ${records}/x`, 'rsync'],
  [`rsync -t src/ ${records}/`, 'rsync'],
  [`cat > /tmp/x <<'EOF'\nfoo\nEOF\nrm ${records}/x\nEOF`, 'rm'],
  [`cat > /tmp/x <<-'EOF'\nfoo\n\tEOF\nrm ${records}/x`, 'rm'],
] as const

// why: the probes of 7c5d875e, 34a8b202 and 3b36ab23: each line names the records and holds a construct outside the parsed subset or a command outside the closed table, so it is refused as unanalysed, naming its earliest construct; the base refused each but perl -I, and 3b36ab23 let the rsync and install rows through.
const unmodelled = [
  [`cd ${records} && rm mail/x`, 'cd'],
  [`cd ${records}; echo $(true)`, 'cd'],
  [`pushd ${records} && rm mail/x`, 'pushd'],
  [`d=${records}; rm -rf "$d/mail"`, '$d'],
  [`rm ${records}/mail/*`, `${records}/mail/*`],
  [`find ${records} -name x -exec rm {} ;`, '-exec'],
  [`find ${records} -name x -delete`, '-delete'],
  [`ls ${records} | xargs rm`, 'xargs'],
  [`if true; then rm ${records}/x; fi`, 'if'],
  [`for f in ${records}/*; do rm "$f"; done`, 'for'],
  [`( rm ${records}/x )`, '('],
  [`{ rm ${records}/x; }`, '{'],
  [`echo $(rm ${records}/x)`, '$('],
  [`echo \`rm ${records}/x\``, '`'],
  [`cat <(rm ${records}/x)`, '<('],
  [`echo x > >(tee ${records}/x)`, '>('],
  [`ls & rm ${records}/x`, '&'],
  [`echo 'rm ${records}/x' | bash`, 'bash'],
  [`echo 'rm ${records}/x' |\nbash`, 'bash'],
  [`bash <<'EOF'\nrm ${records}/x\nEOF`, '<<'],
  [`sh <<< "rm ${records}/x"`, '<<<'],
  [`eval "rm ${records}/x"`, 'eval'],
  [`rm \\\n${records}/x`, '\\'],
  [`cd ${records}/ok && printf '{}' > abc.json`, 'cd'],
  [`python3 -c "open('${records}/x','w').write('')"`, '-c'],
  [`python3 - <<'EOF'\nopen('${records}/x','w').write('')\nEOF`, '<<'],
  [`herdr pane send-text w1:p2 'rm ${records}/x'`, 'herdr'],
  [`stdbuf -oL rm ${records}/x`, 'stdbuf'],
  [`busybox rm ${records}/x`, 'busybox'],
  [`perl -I${records}/lib /tmp/s.pl`, 'perl'],
  [`rsync -a src/ ${records}/ --exclude '*.tmp'`, 'rsync --exclude'],
  [`install src ${records}/x -m 644`, 'install -m'],
  [`rsync --remove-source-files ${records}/x /tmp/`, 'rsync --remove-source-files'],
  [`su -c "rm ${records}/x"`, 'su'],
  [`sh -c 'rm "$1"' _ ${records}/x`, '-c'],
  [`python3 -c 'import sys; open(sys.argv[1],"w")' ${records}/x`, '-c'],
  [`awk '{print > "${records}/x"}' /dev/null`, 'awk'],
  [`perl -pi -e s/a/b/ ${records}/x`, '-e'],
  [`sed -i s/a/b/ ${records}/x`, 'sed -i'],
  [`X+=1 rm ${records}/x`, 'X+='],
  [`tree ${records}`, 'tree'],
] as const

// why: regression pins from the review of 67db77f8: the base refuses each, and 67db77f8 let it through, since its table entry admitted a form that runs a program or writes elsewhere.
const entryPins = [
  [`git -c diff.external='rm ${records}/x' diff`, 'git -c'],
  [`git config core.fsmonitor 'rm ${records}/x'`, 'git config'],
  [`sed 's/^/rm /ge' ${records}/x`, 'sed s/^/rm /ge'],
  [`sed '$!e rm ${records}/y' /tmp/f`, `sed $!e rm ${records}/y`],
  [`sed -e '1e rm ${records}/x' -e p /tmp/f`, `sed 1e rm ${records}/x`],
  [`rsync -a --backup-dir=${records}/b /tmp/x /tmp/y`, 'rsync --backup-dir'],
  [`rsync -a --temp-dir=${records}/t /tmp/x /tmp/y`, 'rsync --temp-dir'],
  [`rsync -a --partial-dir=${records}/p /tmp/x /tmp/y`, 'rsync --partial-dir'],
  [`LESSOPEN='|rm ${records}/x %s' less /tmp/f`, 'LESSOPEN='],
] as const

// why: new refusals from the review of 67db77f8: the base and 67db77f8 both let each through, since neither read sed's w flag without a space nor sort's -o in every spelling.
const newEntryRefusals = [
  [`sed 's/x/y/w${records}/x' /tmp/f`, `sed s/x/y/w${records}/x`],
  [`sort -o${records}/x /tmp/f`, `sort -o${records}/x`],
  [`sort -uo ${records}/x /tmp/f`, 'sort -uo'],
  [`sort --out=${records}/x /tmp/f`, `sort --out=${records}/x`],
] as const

// why: regression pins from the review of 0a412974: the base refuses each, and 0a412974 let it through, since sort's entry admitted a program it runs and git's admitted mv and rm, which write paths git's entry does not model.
const lastEntryPins = [
  [`sort --compress-program='rm ${records}/x' /tmp/f`, `sort --compress-program=rm ${records}/x`],
  [`git mv a ${records}/x`, 'git mv'],
  [`git rm ${records}/x`, 'git rm'],
] as const

// why: new refusals from the review of 0a412974: the base and 0a412974 both let each through, since gh has no destination model for a download, a clone or an output file, sort writes its temporary files where -T says, and git config edit opens an editor.
const lastEntryRefusals = [
  [`gh run download 1 -D ${records}/x`, 'gh run download'],
  [`gh release download v1 -O ${records}/x`, 'gh release download'],
  [`gh repo clone o/r ${records}/x`, 'gh repo clone'],
  [`sort -T ${records}/t /tmp/f`, 'sort -T'],
  [`sort --temporary-directory=${records}/t /tmp/f`, `sort --temporary-directory=${records}/t`],
  [`git config edit # ${records}`, 'git config'],
] as const

// why: each names a denied word only as an argument, or runs a read-only subcommand; a raw -f field is a literal even when it starts with @.
const delegatedReads = [
  'git log --grep commit',
  'git cat-file commit HEAD',
  'grep -rn merge src/',
  'git stash push',
  'gh pr status',
  'gh pr -R o/r view 3',
  'gh api graphql -f query=\'query{viewer{login}}\'',
  'gh api graphql -f query=@q.graphql',
  'gh api graphql -f query=\'query($n:Int){viewer{login}}\' -F n=3',
  'git diff',
  'git log --grep push',
  'git status',
  'git log --oneline',
]

// why: the wrappers and git's global options are skipped, and a line the parser does not read keeps the raw-line rule; each refusal names its exact cause.
const delegatedWrites = [
  ['git -C x push', '`push`'],
  ['env git push', '`push`'],
  ['command git push', '`push`'],
  ['exec git push', '`push`'],
  ['nice git push', '`push`'],
  ['nohup git push', '`push`'],
  ['timeout 5 git push', '`push`'],
  ['time git push', '`push`'],
  ['sudo git push', '`push`'],
  ['/usr/bin/git push', '`push`'],
  ['git --no-pager -c color.ui=never merge main', '`merge`'],
  ['git branch -D other', '`branch -D`'],
  ['git pu', '`git alias pu`'],
  ['echo $(git push)', '`push`'],
  ['xargs git push', '`push`'],
  ['find . -exec git push ;', '`push`'],
  ['bash -c \'git push\'', '`push`'],
  ['printf \'git push\' | bash -s', '`push`'],
  ['gh api graphql -F query=@q.graphql', '`gh api graphql` with a field read from a file (`-F query=@q.graphql`)'],
  ['gh api graphql -f query=\'query{viewer{login}}\' -F query=@q.graphql', '`gh api graphql` with a field read from a file (`-F query=@q.graphql`)'],
  ['gh api graphql --input q.json', '`gh api graphql` with `--input`, whose body the guard cannot read'],
  ['gh api graphql -f query="$Q"', '`gh api graphql` whose query holds `$Q`'],
  ['gh api graphql -f query=\'mutation{deleteRef(input:{}){clientMutationId}}\'', '`gh api graphql` with a `mutation`'],
] as const

// why: regression pins from the review of 34a8b202: the base refuses each, and 34a8b202 let it through.
const delegatedBypasses = [
  ['stdbuf -oL git push', '`push`'],
  ['flock /tmp/l git push', '`push`'],
  ['X+=1 git push', '`push`'],
  ['env A.B=c git push', '`push`'],
  ['builtin command git push', '`push`'],
  ['echo \'git push\' |\nbash', '`push`'],
] as const

// why: regression pins from the review of 3b36ab23: the base refuses each, and 3b36ab23 let it through, since each runs a command the closed table does not hold.
const tableBypasses = [
  ['watch \'git push\'', '`push`'],
  ['printf \'git push\' | sh /dev/stdin', '`push`'],
  ['git submodule foreach git push', '`push`'],
  ['git bisect run git push', '`push`'],
  ['make push', '`push`'],
] as const

// why: regression pins from the review of 67db77f8: the base refuses each, and 67db77f8 let it through, since git's or perl's table entry admitted a form that runs another program.
const entryBypasses = [
  ['git -c diff.external=\'git push\' diff', '`push`'],
  ['GIT_EXTERNAL_DIFF=\'git push\' git diff', '`push`'],
  ['git grep -O\'git push\' x', '`push`'],
  ['git -c core.fsmonitor=\'git push\' status', '`push`'],
  ['git fetch --upload-pack=\'git push\' origin', '`push`'],
  ['git config core.fsmonitor \'git push\'', '`push`'],
  ['perl -i -n0e \'system "git push"\' /tmp/f', '`push`'],
  ['git fetch --upload-pa=\'git push\' origin', '`push`'],
  ['git grep -iO\'git push\' x', '`push`'],
] as const

/**
 * Builds a repository whose unit branch `feat` starts at the default branch, with the git alias `pu` for push.
 * @returns The history.
 */
const graph = (): Graph => ({ commits: { a: { parents: [], files: { f: 'a' } } }, refs: { main: 'a', 'origin/main': 'a', feat: 'a' }, aliases: { pu: 'push' } })

/**
 * Escapes text for a regular expression.
 * @param text - The text.
 * @returns The pattern that matches it literally.
 */
const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Asserts a records refusal as unanalysed: it names exactly the construct, after one of the verbs the refusals use, names no other
 * construct of the records lists, says a write cannot be ruled out, and never claims one was found.
 * @param deny - The refusal.
 * @param construct - The construct it must name.
 */
function expectUnanalysed(deny: string, construct: string): void {
  const names = (named: string): RegExp => new RegExp(`(contains|holds|through|runs|uses) ${escapePattern(`\`${named}\``)}`)
  expect(deny).toContain(recordsDeny)
  expect(deny).toMatch(names(construct))
  for (const [, other] of [...unmodelled, ...entryPins, ...newEntryRefusals, ...lastEntryPins, ...lastEntryRefusals]) {
    if (other !== construct) expect(deny).not.toMatch(names(other))
  }
  expect(deny).toContain('cannot be ruled out')
  expect(deny).not.toMatch(/\bfound\b|writes there/)
}

/**
 * Arranges a unit session on `feat` for issue 3 with the Fix flow declared, delegated by the coordinator `coord` unless told otherwise.
 * @param $ - The engine.
 * @param on - The hook registrar.
 * @param options - Further world options.
 * @param isDelegated - Whether a scope delegates issue 3.
 */
async function arrangeUnit($: Engine, on: Parameters<typeof createWorld>[0], options: Options = {}, isDelegated = true): Promise<void> {
  const world = createWorld(on, { branch: 'feat', graph: graph() }, { session: noFlow, ...options })
  markSpawned(world, [3])
  if (isDelegated) world.files.set(scopeFile('coord'), buildScope('coord', [3]))
  await declareFlow($, 'fix', [3])
}

for (const command of recordReads) {
  // contract: a command that only reads the records, or writes elsewhere, passes the records guard
  test(`the records guard lets ${JSON.stringify(command)} run`, async ($, on) => {
    createWorld(on, { branch: 'feat' }, { session: noFlow })
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  })
}

for (const command of quotedArrows) {
  // contract: a quoted `->` or `>` in a string argument is no redirection, so the records guard lets the read run; fails on base 038a3f7e, which refused it as a write
  test(`the records guard lets ${JSON.stringify(command)} run, reading its quoted arrow as text`, async ($, on) => {
    createWorld(on, { branch: 'feat' }, { session: noFlow })
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  })
}

// contract: inline code holding a quoted `->` on a line that names the records is refused as unanalysed inline code only, never as a write; fails on base 038a3f7e, which refused it as a write without naming inline code
test('the records guard refuses python3 -c printing a quoted arrow beside a records path as unanalysed inline code, not as a write', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  const deny = (await $.tool.call({ tool: 'Bash', command: `python3 -c "print(a, '->', b)" ${records}/x` })).deny ?? ''
  expect(deny).toContain(recordsDeny)
  expect(deny).toContain('runs inline code through `-c`, which the guard does not analyse')
  expect(deny).toContain('cannot be ruled out')
  expect(deny).not.toContain('writes there')
})

for (const [command, token] of recordWrites) {
  // contract: a write under the records is refused, naming exactly the token that writes and no other cause
  test(`the records guard refuses ${JSON.stringify(command)}, naming \`${token}\``, async ($, on) => {
    createWorld(on, { branch: 'feat' }, { session: noFlow })
    const deny = (await $.tool.call({ tool: 'Bash', command })).deny ?? ''
    expect(deny).toContain(recordsDeny)
    expect(deny).toContain(`This command writes there through \`${token}\`.`)
    for (const [, other] of recordWrites) {
      if (other !== token) expect(deny).not.toContain(`through \`${other}\``)
    }
    expect(deny).not.toContain('cannot be ruled out')
  })
}

for (const [command, construct] of unmodelled) {
  // contract: a line that names the records and holds a construct outside the parsed subset or a command outside the closed table is refused, naming exactly its earliest construct and no other, and saying a write cannot be ruled out, never that one was found
  test(`the records guard refuses ${JSON.stringify(command)} as unanalysed, naming \`${construct}\``, async ($, on) => {
    createWorld(on, { branch: 'feat' }, { session: noFlow })
    expectUnanalysed((await $.tool.call({ tool: 'Bash', command })).deny ?? '', construct)
  })
}

for (const [command, construct] of entryPins) {
  // contract: regression pin: refused at base 038a3f7e and allowed at 67db77f8, a records line whose command uses a form outside the table's admission rule is refused as unanalysed, naming that form
  test(`the records guard refuses ${JSON.stringify(command)} as a form outside the table, naming \`${construct}\``, async ($, on) => {
    createWorld(on, { branch: 'feat' }, { session: noFlow })
    expectUnanalysed((await $.tool.call({ tool: 'Bash', command })).deny ?? '', construct)
  })
}

for (const [command, construct] of newEntryRefusals) {
  // contract: new refusal, allowed at base 038a3f7e and at 67db77f8: sed's w flag written without a space and sort's -o in any spelling write the file they name, so they leave the table
  test(`the records guard refuses ${JSON.stringify(command)} as a form outside the table, naming \`${construct}\``, async ($, on) => {
    createWorld(on, { branch: 'feat' }, { session: noFlow })
    expectUnanalysed((await $.tool.call({ tool: 'Bash', command })).deny ?? '', construct)
  })
}

for (const [command, construct] of lastEntryPins) {
  // contract: regression pin: refused at base 038a3f7e and allowed at 0a412974, a records line whose command uses a form outside the table's admission rule is refused as unanalysed, naming that form
  test(`the records guard refuses ${JSON.stringify(command)} as a form outside the table, naming \`${construct}\``, async ($, on) => {
    createWorld(on, { branch: 'feat' }, { session: noFlow })
    expectUnanalysed((await $.tool.call({ tool: 'Bash', command })).deny ?? '', construct)
  })
}

for (const [command, construct] of lastEntryRefusals) {
  // contract: new refusal, allowed at base 038a3f7e and at 0a412974: a gh download, clone or output file, sort's -T and git config edit write where the table does not model, so they leave it
  test(`the records guard refuses ${JSON.stringify(command)} as a form outside the table, naming \`${construct}\``, async ($, on) => {
    createWorld(on, { branch: 'feat' }, { session: noFlow })
    expectUnanalysed((await $.tool.call({ tool: 'Bash', command })).deny ?? '', construct)
  })
}

// contract: a form outside the table that may name the records only as text, such as a commit message, is refused with advice to pass that text from a file, not to read with a known reader alone
test('the records guard refuses a git commit naming the records in its message, pointing to git commit -F', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  const deny = (await $.tool.call({ tool: 'Bash', command: `git commit -m "see ${records}/x"` })).deny ?? ''
  expect(deny).toContain('uses `git commit`, a form outside the guard\'s table of known commands')
  expect(deny).toContain('pass that text from a file (git commit -F)')
})

// contract: a program outside the table is refused on a records line with advice to read the records with a known reader, never to split the line
test('the records guard refuses tree on the records, pointing to cat, grep, jq or the Read tool', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  const deny = (await $.tool.call({ tool: 'Bash', command: `tree ${records}` })).deny ?? ''
  expect(deny).toContain('runs `tree`, which is not in the guard\'s table of known commands')
  expect(deny).toContain('read the records with cat, grep or jq, or with the Read tool')
  expect(deny).not.toContain('split it')
})

// contract: words of an issue write that are only an argument, such as a search pattern, pass the issue guard
test('the issue guard lets a search for issue-write words run', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  for (const command of ['rg \'gh issue comment\' docs/', 'grep -rn "gh label create" src/']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  }
})

// contract: an issue write in command position is refused behind a wrapper, an assignment, a pipe or gh's repository option on either side of the subcommand, and a line the parser does not read keeps the raw-line rule
test('the issue guard refuses gh issue and label writes where they run', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  for (const command of ['gh issue comment 3 -b x', 'env gh issue create -t x', 'command gh issue close 1', 'echo x | gh issue comment 3 -F -', 'ls; gh label delete bug',
    'gh -R o/r issue close 1', 'gh issue -R o/r close 1', 'gh label --repo=o/r delete bug', 'echo $(gh issue comment 1 -b x)', 'echo 1 | xargs gh issue close']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('Raw GitHub issue')
  }
})

// contract: regression pins from the review of 34a8b202: the base refuses each issue write, and 34a8b202 let it through
test('the issue guard refuses an issue write behind an assignment with += or behind builtin', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  for (const command of ['X+=1 gh issue close 1', 'builtin command gh issue close 1']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('Raw GitHub issue')
  }
})

// contract: a command that only names the approval script as a file operand passes the approval guard
test('the approval guard lets git add, grep and shellcheck name the approval script', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  for (const command of ['git add scripts/approve-verify.sh', 'grep -n blob scripts/approve-verify.sh', 'shellcheck scripts/approve-verify.sh']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  }
})

// contract: pin: the approval script is refused where it runs, in command position or as an interpreter's script, as the base refuses it
test('the approval guard refuses the script run through an interpreter or a wrapper', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  for (const command of ['bash scripts/approve-verify.sh 0123', 'env ./approve-verify.sh 0123', 'ls; sh approve-verify.sh 0123', 'bash < approve-verify.sh']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('The Verify config approval is the user\'s alone')
  }
})

for (const command of delegatedReads) {
  // contract: a delegated unit may run a command whose denied words are only arguments
  test(`a delegated unit's ${command} runs`, async ($, on) => {
    await arrangeUnit($, on)
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  })
}

for (const [command, word] of delegatedWrites) {
  // contract: a delegated unit's denied git or gh subcommand is refused behind git's global options, wrappers and a full path, naming exactly its cause in backticks; the wrapper rows pin a refusal the base also makes, and only the naming is new
  test(`a delegated unit's ${command} is refused, naming ${word}`, async ($, on) => {
    await arrangeUnit($, on)
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain(`(it names ${word}): `)
  })
}

for (const [command, word] of delegatedBypasses) {
  // contract: regression pin: the base refuses this denied subcommand behind an unknown runner, an assignment, builtin or a pipe continued on the next line, and 34a8b202 let it through
  test(`a delegated unit's ${JSON.stringify(command)} is refused, naming ${word}`, async ($, on) => {
    await arrangeUnit($, on)
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain(`(it names ${word}): `)
  })
}

for (const [command, word] of tableBypasses) {
  // contract: regression pin: refused at base 038a3f7e and allowed at 3b36ab23, a denied subcommand that a program outside the closed table runs is refused through the raw-line rule
  test(`a delegated unit's ${JSON.stringify(command)} is refused, naming ${word}`, async ($, on) => {
    await arrangeUnit($, on)
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain(`(it names ${word}): `)
  })
}

for (const [command, word] of entryBypasses) {
  // contract: regression pin: refused at base 038a3f7e and allowed at 67db77f8, a denied subcommand that a git or perl form outside the table's admission rule runs is refused through the raw-line rule
  test(`a delegated unit's ${JSON.stringify(command)} is refused, naming ${word}`, async ($, on) => {
    await arrangeUnit($, on)
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain(`(it names ${word}): `)
  })
}

// contract: regression pin: refused at base 038a3f7e and allowed at 3b36ab23, a git commit or an issue write that a program outside the closed table runs is refused through the raw-line rule
test('a delegated unit\'s git commit run by flock -c and an issue write run by script -qc are refused', async ($, on) => {
  await arrangeUnit($, on)
  expect((await $.tool.call({ tool: 'Bash', command: 'flock /tmp/l -c \'git commit -m x\'' })).deny).toContain('a Bash git commit is refused')
  expect((await $.tool.call({ tool: 'Bash', command: 'script -qc \'gh issue close 1\' /dev/null' })).deny).toMatch(/raw GitHub issue/i)
})

// contract: new refusal, allowed at base 038a3f7e and at 3b36ab23: the raw-line issue rule skips gh's repository option after the subcommand, as the parsed rule does
test('an issue write behind a program outside the table with -R after issue is refused', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  expect((await $.tool.call({ tool: 'Bash', command: 'ionice gh issue -R o/r close 1' })).deny).toContain('Raw GitHub issue')
})

// contract: text typed through herdr runs in another terminal, so a delegated unit's denied word in it is refused as on the raw line
test('a delegated unit\'s denied git subcommand typed through herdr is refused', async ($, on) => {
  await arrangeUnit($, on)
  expect((await $.tool.call({ tool: 'Bash', command: 'herdr pane send-text w1:p2 \'git push\'' })).deny).toContain('(it names `push`): ')
})

// contract: a delegated unit's git reset is refused with the way to unstage a file
test('a delegated unit\'s git reset -- <file> is refused, pointing to git restore --staged', async ($, on) => {
  await arrangeUnit($, on)
  const deny = (await $.tool.call({ tool: 'Bash', command: 'git reset -- f' })).deny ?? ''
  expect(deny).toContain('(it names `reset`; `git restore --staged f` unstages without moving a ref): ')
})

// contract: pin: a delegated unit's git commit is refused where commit is git's subcommand, behind its global options too, and on a line the parser does not read, as the base refuses it
test('a delegated unit\'s git commit behind global options or a substitution is refused for the commit tool', async ($, on) => {
  await arrangeUnit($, on)
  for (const command of ['git -C x commit -m y', 'git --no-pager commit', 'echo $(git commit -m x)']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('a Bash git commit is refused')
  }
})

// contract: regression pin from the review of 34a8b202: the base refuses a git commit behind an unknown runner, an assignment with += or builtin, and 34a8b202 let it through
test('a delegated unit\'s git commit behind setsid, an assignment or builtin is refused for the commit tool', async ($, on) => {
  await arrangeUnit($, on)
  for (const command of ['setsid git commit -m x', 'X+=1 git commit -m x', 'builtin command git commit -m x']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('a Bash git commit is refused')
  }
})

// contract: before the diagnosis is approved, only a git commit is refused, never a command that names commit as an argument
test('a declared unit waiting for its approval may run git log --grep commit, while git commit is refused', async ($, on) => {
  await arrangeUnit($, on, {}, false)
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })).deny).toContain('Commit is refused')
  expect((await $.tool.call({ tool: 'Bash', command: 'git log --grep commit' })).deny).toBeUndefined()
})

// contract: a heavy test run is the configured runner with its configured subcommand where a subcommand stands, not the runner alone
test('a delegated unit\'s npm install and npm view test run while the Verify config runs npm test, and npm test is refused naming it', async ($, on) => {
  const config = '{"always":[["npm","test"]]}'
  await arrangeUnit($, on, { verifyFile: config, approvedConfig: config })
  for (const command of ['npm install', 'npm view test']) expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'npm test' })).deny).toContain('(`npm test`)')
})

// contract: regression pin from the review of 34a8b202: a runner configured with an option as its next word is heavy in any run, as the base refuses it, which 34a8b202 let through
test('a delegated unit\'s run of a runner configured with an option, as this repository configures its runners, is refused', async ($, on) => {
  const config = JSON.stringify({ always: [['x.sh', '--tier', 'fast']], rules: [
    { paths: ['**'], run: ['test/runners/mods.sh', '--checks'] },
    { paths: ['**'], run: ['test/runners/bash.sh', '--tier', 'fast', 'test/bats/mods'] },
  ] })
  await arrangeUnit($, on, { verifyFile: config, approvedConfig: config })
  for (const command of ['x.sh --tier slow t', 'x.sh', 'test/runners/bash.sh --tier fast test/bats/core', 'test/runners/mods.sh public/x.test.ts']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('the run tool')
  }
})

// contract: regression pin: refused at base 038a3f7e and allowed at 3b36ab23, an option before the subcommand may take the next word as its value, so the word after it may be the subcommand
test('a delegated unit\'s npm --prefix x test is refused while the Verify config runs npm test', async ($, on) => {
  const config = '{"always":[["npm","test"]]}'
  await arrangeUnit($, on, { verifyFile: config, approvedConfig: config })
  expect((await $.tool.call({ tool: 'Bash', command: 'npm --prefix x test' })).deny).toContain('(`npm test`)')
})

// contract: new refusal, allowed at base 038a3f7e and at 3b36ab23: a configured interpreter is matched as the program before its script
test('a delegated unit\'s node --test is refused while the Verify config runs node --test', async ($, on) => {
  const config = '{"always":[["node","--test"]]}'
  await arrangeUnit($, on, { verifyFile: config, approvedConfig: config })
  expect((await $.tool.call({ tool: 'Bash', command: 'node --test test/a.test.js' })).deny).toContain('(`node`)')
})

// contract: regression pin: refused at base 038a3f7e and allowed at 67db77f8, pnpm and yarn run an unknown word as a script or binary, as npx does
test('a delegated unit\'s pnpm bats test is refused as a Bats run', async ($, on) => {
  await arrangeUnit($, on)
  expect((await $.tool.call({ tool: 'Bash', command: 'pnpm bats test' })).deny).toContain('(`bats`)')
})

// contract: on a line of commands in the table, an interpreter named inside a quoted argument is no script run
test('a script candidate is an interpreter\'s operand in command position, never words inside a quoted argument', () => {
  expect(listScriptCandidates('echo \'bash x.sh\'')).toEqual([])
  expect(listScriptCandidates('git log --grep "run node a.js"')).toEqual([])
  expect(listScriptCandidates('env bash -x a.sh b')).toEqual([['a.sh', 'b']])
})

// contract: pin: the delegated word guard applies only to a delegated unit, as at the base
test('a session with no flow is not refused for a denied git subcommand', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  expect((await $.tool.call({ tool: 'Bash', command: 'git -C x push' })).deny).toBeUndefined()
})
