import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildBashCall, twoIssueCloseOut, verifyFile } from '../support/builders'
import { readFlowStatus, readPromptContext, startSkill } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Options } from '../support/world'

// On a Close out of #1 and #2 a PR body of "x" lacks its Closes lines and a deny shows the command was read as a PR write.
const lacks = 'PR body lacks'

// Runs every command against the deny it should get: a string it must contain, or undefined for none.
async function expectDenies($: Engine, cases: [string, string | undefined][]) {
  for (const [command, deny] of cases) {
    const got = (await $.tool.call(buildBashCall(command))).deny
    if (deny === undefined) expect(got, command).toBeUndefined()
    else expect(got, command).toContain(deny)
  }
}

test('a gh pr edit named inside another command\'s argument is not a PR edit', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1, isDirty: true }, { ...twoIssueCloseOut, verifyFile, unit: { skills: ['generate-commit'] } })
  await $.tool.call(buildBashCall('./test/run.sh'))
  await expectDenies($, [
    ["git add a && echo 'run gh pr edit 5 --body x'", undefined],
    ['git log --grep "gh pr create --body x"', undefined],
    ['gh pr edit 5 --body x', 'working tree is dirty'],
    ['git add a && gh pr edit 5 --body x', 'working tree is dirty'],
  ])
})

test('a gh pr edit inside a heredoc body is not a PR edit', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueCloseOut)
  await expectDenies($, [
    ["python3 - <<'EOF'\nprint('gh pr edit 5 --body-file /tmp/b')\nEOF", undefined],
    ['cat <<EOF\ngh pr create --body x\nEOF', undefined],
    ["python3 - <<'EOF'\nprint(1)\nEOF\ngh pr edit 5 --body x", lacks],
    ["python3 - <<'EOF'\nprint(1)\nEOF\ngh pr edit 5 --body-file /tmp/b", lacks],
  ])
})

// VAR=value, sudo, env, command, exec, nohup and time (with their flags) are transparent before the command.
test('transparent prefixes still run the command', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueCloseOut)
  await expectDenies($, [
    ['GH=1 gh pr create --body x', lacks],
    ['A=1 B=2 gh pr create --body x', lacks],
    ['sudo gh pr create --body x', lacks],
    ['sudo -u root gh pr create --body x', lacks],
    ['env -i gh pr create --body x', lacks],
    ['env FOO=1 gh pr create --body x', lacks],
    ['command gh pr create --body x', lacks],
    ['exec gh pr create --body x', lacks],
    ['nohup gh pr create --body x', lacks],
    ['time -p gh pr create --body x', lacks],
    ['/usr/bin/gh pr create --body x', lacks],
    ['\\gh pr create --body x', lacks],
    ['echo "sudo gh pr create --body x"', undefined],
    ['echo env gh pr create --body x', lacks],
  ])
})

test('quoted mentions of a guarded command give no verdict', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, verifyFile })
  await expectDenies($, [
    ['echo "gh issue create"', undefined],
    ["printf 'gh pr create --body x'", undefined],
    ['echo "gh pr edit 5 --body x"', undefined],
    ['gh pr create --body x', lacks],
  ])
  // Outside the issue skills a real gh issue create asks, and a commit asks before Verify has run; a mention does neither.
  const decision = async (command: string) => (await $.tool.check({ tool: 'Bash', input: { command } })).decision
  expect(await decision('echo "gh issue create"'), 'echo issue').toBe('allow')
  expect(await decision('gh issue create --title t'), 'real issue').toBe('ask')
  expect(await decision('echo "git commit -m x"'), 'echo commit').toBe('allow')
  expect(await decision("printf 'git commit'"), 'printf commit').toBe('allow')
  // A commit is the user's step, denied directly or in a subshell; a message naming gh issue create is still just a commit.
  for (const command of ['git commit -m x', '(git commit -m x)', 'git commit -m "gh issue create --title t"']) {
    expect((await $.tool.call(buildBashCall(command))).deny, command).toContain("git commit is the user's step")
  }
  expect((await $.tool.call(buildBashCall('git commit -m "gh issue create --title t"'))).deny).not.toContain('gh issue create')
})

test('a command is caught in every segment of a compound line', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueCloseOut)
  await expectDenies($, [
    ['ls && gh pr create --body x', lacks],
    ['false || gh pr create --body x', lacks],
    ['ls; gh pr create --body x', lacks],
    ['echo hi | gh pr create --body x', lacks],
    ['ls\ngh pr create --body x', lacks],
    ['ls && gh pr edit 5 --body x', lacks],
    ['(gh pr create --body x)', lacks],
    ['ls && (gh pr edit 5 --body x)', lacks],
    ['((gh pr create --body x))', lacks],
    ['(cd x; gh pr create --body x)', lacks],
    ['ls && echo gh pr create --body x', lacks],
    ['ls; echo gh pr edit 5 --body x', lacks],
  ])
})

// Code a shell will execute (sh -c, eval, $(...), backticks outside single quotes) is checked; single-quoted text is not.
test('code a shell will run is checked recursively', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueCloseOut)
  await expectDenies($, [
    ["bash -c 'gh pr create --body x'", lacks],
    ["sh -c 'gh pr create --body x'", lacks],
    ["zsh -c 'gh pr create --body x'", lacks],
    ["dash -c 'gh pr create --body x'", lacks],
    ['bash -c "ls && gh pr create --body x"', lacks],
    ['eval gh pr create --body x', lacks],
    ['echo $(gh pr create --body x)', lacks],
    ['echo "$(gh pr create --body x)"', lacks],
    ['echo `gh pr create --body x`', lacks],
    ["echo '$(gh pr create --body x)'", undefined],
    ["echo '`gh pr create --body x`'", undefined],
    ["bash -c 'echo gh pr create --body x'", lacks],
    ["bash -c 'echo \"gh pr create --body x\"'", undefined],
    ['( gh pr create --body x )', lacks],
    ['ls & gh pr create --body x', lacks],
    ['timeout 60 gh pr create --body x', lacks],
    ['nice -n 5 gh pr create --body x', lacks],
    ['xargs gh pr create --body x', lacks],
    ['doas gh pr create --body x', lacks],
    ["\\bash -c 'gh pr create --body x'", lacks],
    ['cat <(gh pr create --body x)', lacks],
    ['tee >(gh pr create --body x)', lacks],
    ["bash -c -- 'gh pr create --body x'", lacks],
  ])
})

test('a body fed by a heredoc inside a substitution is read whole', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueCloseOut)
  const doc = "$(cat <<'EOF'\nCloses #1\nCloses #2\nEOF\n)"
  await expectDenies($, [
    [`gh pr create --title t --body "${doc}"`, undefined],
    [`gh pr edit 5 --body "${doc}"`, undefined],
    ["gh pr create --title t --body \"$(cat <<'EOF'\nCloses #1\nEOF\n)\"", lacks],
  ])
})

test('body flags and body text of another segment do not count', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueCloseOut)
  await expectDenies($, [
    ['gh pr edit 5 --add-label x && echo --body', undefined],
    ['gh pr edit 5 --add-label x; echo -b', undefined],
    ['echo "Closes #1\nCloses #2" && gh pr create --body nothing', lacks],
    ['echo "Closes #1" && gh pr create --body nothing', lacks],
    ['gh pr edit 5 --body x && echo done', lacks],
    ['gh pr create --body nothing && echo "Closes #1 Closes #2"', lacks],
    ['gh pr create --body nothing && echo "Closes #1\nCloses #2"', lacks],
  ])
})

test('only a real gh issue create is observed', async ($, on) => {
  createWorld(on, { branch: 'feat' }, {
    session: { issues: [], info: {} }, toolRun: { result: { stdout: 'https://github.com/o/r/issues/7\n' } },
    issueLabels: { 7: ['ready-for-agent'] },
  })
  await startSkill($, 'grilling')
  await startSkill($, 'to-spec')
  await $.tool.call(buildBashCall('echo "gh issue create"'))
  expect(await readPromptContext($)).not.toContain('#7')
  await $.tool.call(buildBashCall('gh issue create --title t --body-file spec.md'))
  expect(await readPromptContext($)).toContain('Small feature #7 — current step: Code')
})

test('only a real gh pr edit confirms the PR', async ($, on) => {
  const closes = 'Closes #1\nCloses #2'
  const options: Options = {
    ...twoIssueCloseOut, unit: { skills: ['generate-commit'], pr: { number: 5, state: 'OPEN' } },
    prView: { body: closes, headRefOid: 'c1' }, toolRun: { result: { stdout: 'https://github.com/o/r/pull/5\n' } },
  }
  createWorld(on, { branch: 'feat', ahead: 1 }, options)
  await startSkill($, 'create-pr')
  await $.tool.call(buildBashCall('echo "gh pr edit 5"'))
  await $.tool.call(buildBashCall('echo "gh pr create --body x"'))
  expect(await readFlowStatus($)).not.toContain('Unit finished.')
  await $.tool.call(buildBashCall(`gh pr edit 5 --body "${closes}"`))
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

// Input that cannot be parsed falls back to matching the whole command, so a guarded command still gets its verdict.
test('unparseable input never lets a guarded command through', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueCloseOut)
  await expectDenies($, [
    ['gh pr create --body "x', lacks],
    ["gh pr create --body 'x", lacks],
    ["cat <<'EOF\nbody\ngh pr create --body x", lacks],
    ['cat <<\ngh pr create --body x', lacks],
    ['bash <<EOF\ngh pr create --body x\nEOF', lacks],
    ["bash -s <<'EOF'\ngh pr create --body x\nEOF", lacks],
  ])
})

test('only a real gh issue edit moves the flow from Spec to Code', async ($, on) => {
  createWorld(on, { branch: 'feat' }, {
    session: { issues: [1], info: { 1: { title: 'a', labels: [] } } }, unit: { skills: ['grilling'] },
    issues: { 1: 'OPEN' }, issueLabels: { 1: ['ready-for-agent'] },
  })
  await startSkill($, 'to-spec')
  expect(await readPromptContext($)).toContain('current step: Spec')
  await $.tool.call(buildBashCall('echo "gh issue edit 1"'))
  expect(await readPromptContext($)).toContain('current step: Spec')
  await $.tool.call(buildBashCall('gh issue edit 1 --body-file spec.md'))
  expect(await readPromptContext($)).toContain('current step: Code')
})
