import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildBashCall, twoIssueCloseOut } from '../../support/builders'
import { setPermissionMode } from '../../support/helpers'
import { createWorld, root } from '../../support/world'
import type { Checkout, Options } from '../../support/world'

// A guarded command, the world it is judged in, and the verdict it must get both directly and inside a herdr pane run.
interface GatedCase { name: string; command: string; git: Checkout; options?: Options; verdict: string | undefined }

const closes = 'Closes #1\nCloses #2'
const bodyFiles = { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: closes }
const cases: GatedCase[] = [
  { name: 'gh pr create lacking a Closes line', command: 'gh pr create --title t --body "Closes #1"', git: { branch: 'feat' }, options: twoIssueCloseOut, verdict: 'lacks Closes #2' },
  { name: 'gh pr create with every Closes line', command: `gh pr create --title t --body "${closes}"`, git: { branch: 'feat' }, options: twoIssueCloseOut, verdict: undefined },
  { name: 'gh pr create reading a body file that lacks a line', command: `gh pr create --title t --body-file ${root}/one.md`, git: { branch: 'feat' }, options: { ...twoIssueCloseOut, files: bodyFiles }, verdict: 'lacks Closes #2' },
  { name: 'gh pr create reading a complete body file', command: `gh pr create --title t -F ${root}/both.md`, git: { branch: 'feat' }, options: { ...twoIssueCloseOut, files: bodyFiles }, verdict: undefined },
  { name: 'gh pr create on a dirty tree', command: `gh pr create --title t --body "${closes}"`, git: { branch: 'feat', isDirty: true }, options: twoIssueCloseOut, verdict: 'working tree is dirty' },
  { name: 'gh pr edit setting a body that lacks a line', command: 'gh pr edit 5 --body "Closes #1"', git: { branch: 'feat' }, options: twoIssueCloseOut, verdict: 'lacks Closes #2' },
  { name: 'gh pr edit changing only a label', command: 'gh pr edit 5 --add-label x', git: { branch: 'feat', isDirty: true }, options: twoIssueCloseOut, verdict: undefined },
  { name: 'gh pr merge', command: 'gh pr merge 5 --squash', git: { branch: 'feat', ahead: 1 }, verdict: "gh pr merge is the user's step" },
  { name: 'git commit', command: 'git commit -m x', git: { branch: 'feat', ahead: 1 }, verdict: "git commit is the user's step" },
  { name: 'gh issue create outside the issue skills', command: 'gh issue create --title t --body b', git: { branch: 'feat' }, verdict: 'gh issue create outside' },
]

// The ways a herdr pane run can be written: a prefix, a program path or herdr's own options never hide it.
const paneRunForms = ['herdr', 'env herdr', 'sudo herdr', '/usr/local/bin/herdr', 'herdr --json']

// The verdict a call gets in a mode that never asks, so an ask shows as a deny.
const judge = async ($: Engine, command: string): Promise<string | undefined> => (await $.tool.call(buildBashCall(command))).deny

for (const gated of cases) {
  test(`${gated.name} gets the same verdict directly and inside a herdr pane run`, async ($, on) => {
    createWorld(on, gated.git, gated.options ?? {})
    await setPermissionMode($, 'auto')
    for (const command of [gated.command, `herdr pane run w1:1 '${gated.command.replace(/'/g, `'\\''`)}; echo "__EXIT_g1=$?__"'`]) {
      const verdict = await judge($, command)
      if (gated.verdict === undefined) expect(verdict, command).toBeUndefined()
      else expect(verdict, command).toContain(gated.verdict)
    }
  })
}

test('a herdr pane run writes an absolute repository path as one, and a relative path, whose directory is the pane\'s own, as one too', async ($, on) => {
  // On the default branch every repository write is denied, so a deny shows the command was read as one.
  createWorld(on, { branch: 'main' })
  await setPermissionMode($, 'auto')
  expect(await judge($, `herdr pane run w1:1 'echo x > ${root}/a.txt'`)).toContain('default branch')
  expect(await judge($, `herdr pane run w1:1 'echo x > a.txt'`)).toContain('default branch')
  expect(await judge($, `herdr pane run w1:1 'echo x > /tmp/a.txt'`)).toBeUndefined()
  expect(await judge($, `herdr pane run w1:1 'cd /tmp && echo x > a.txt'`)).toBeUndefined()
})

for (const form of paneRunForms) {
  test(`a user's command inside \`${form} pane run\` is denied as it is when run directly`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 })
    await setPermissionMode($, 'auto')
    expect(await judge($, `${form} pane run w1:1 'git commit -m x; echo "__EXIT_g1=$?__"'`)).toContain("git commit is the user's step")
  })
}
