import { expect } from 'claude-code/testing'

import { test } from '../../support/kit'
import { buildWriteCall, noFlow } from '../../support/builders'
import { readFlowStatus, readPromptContext } from '../../support/helpers'
import { common, createWorld, root } from '../../support/world'

for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
  test(`${tool} on the default branch is denied before the tool runs`, async ($, on) => {
    const ran: string[] = []
    createWorld(on, { branch: 'main' }, { afterTool: () => { ran.push(tool) } })
    const path = `${root}/src/a.ts`
    const input = tool === 'NotebookEdit' ? { notebook_path: path, new_source: '' }
      : tool === 'Edit' ? { file_path: path, old_string: 'old', new_string: 'new' } : { file_path: path, content: '' }
    const result = await $.tool.call({ tool, ...input } as never)
    expect(result.deny).toContain('writing on the default branch (main)')
    expect(result.deny).toContain('git switch -c')
    expect(ran).toHaveLength(0)
  })
}

test('feature-branch writes pass even after switching away from the unit branch', async ($, on) => {
  const git = { branch: 'feat-a' }
  createWorld(on, git)
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
  git.branch = 'feat-b'
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
})

for (const branch of ['main', 'feature']) {
  test(`a subagent write is judged on its ${branch} checkout, not the session checkout`, async ($, on) => {
    createWorld(on, { branch: branch === 'main' ? 'feature' : 'main', worktrees: { '/linked': { branch } } })
    const call = { ...buildWriteCall('/linked/new/deep/file.ts'), agentId: 'worker' }
    const result = await $.tool.call(call)
    if (branch === 'main') expect(result.deny).toContain('default branch (main)')
    else expect(result.deny).toBeUndefined()
  })
}

test('relative paths are denied even outside a repository', async ($, on) => {
  createWorld(on, { branch: 'feature' }, { isOutsideRepo: true })
  expect((await $.tool.call({ tool: 'Write', file_path: 'src/a.ts', content: '' })).deny).toContain('pass an absolute path')
})

test('an outside symlink into the default checkout is denied, including missing descendants', async ($, on) => {
  createWorld(on, { branch: 'main' }, { symlinks: { '/tmp/link': root } })
  expect((await $.tool.call(buildWriteCall('/tmp/link/new/deep/file.ts'))).deny).toContain('default branch (main)')
})

test('an existing file symlink into the default checkout is denied', async ($, on) => {
  const world = createWorld(on, { branch: 'main' }, { symlinks: { '/tmp/link': `${root}/a.ts` } })
  world.files.set(`${root}/a.ts`, 'old')
  expect((await $.tool.call(buildWriteCall('/tmp/link'))).deny).toContain('default branch (main)')
})

test('an existing path without an engine realpath fails closed', async ($, on) => {
  createWorld(on, { branch: 'feature' }, { symlinks: { '/tmp/dangling': null } })
  expect((await $.tool.call(buildWriteCall('/tmp/dangling'))).deny).toContain('check failed')
})

test('ignored files pass on the default branch', async ($, on) => {
  createWorld(on, { branch: 'main' }, { ignored: [`${root}/cache/a.ts`] })
  expect((await $.tool.call(buildWriteCall('cache/a.ts'))).deny).toBeUndefined()
})

for (const [name, path, repositoryCommon] of [
  ['submodule', `${root}/submodule`, `${common}/modules/submodule`],
  ['nested repository', `${root}/nested`, `${root}/nested/.git`],
  ['other repository', '/other', '/other/.git'],
] as const) {
  test(`a ${name} with a different common dir passes`, async ($, on) => {
    createWorld(on, { branch: 'main' }, { repositories: { [path]: { common: repositoryCommon, branch: 'main' } } })
    expect((await $.tool.call(buildWriteCall(`${path}/new/file.ts`))).deny).toBeUndefined()
  })
}

test('paths outside every repository pass', async ($, on) => {
  createWorld(on, { branch: 'main' })
  expect((await $.tool.call(buildWriteCall('/tmp/notes.md'))).deny).toBeUndefined()
})

test('an absolute write from a session outside a repository passes', async ($, on) => {
  createWorld(on, { branch: 'main' }, { isOutsideRepo: true })
  expect((await $.tool.call(buildWriteCall('/tmp/notes.md'))).deny).toBeUndefined()
})

test('git metadata outside the records directory is not judged', async ($, on) => {
  createWorld(on, { branch: 'main' }, { repositories: { [common]: { common, branch: 'main' } } })
  expect((await $.tool.call(buildWriteCall(`${common}/config`))).deny).toBeUndefined()
})

for (const branch of ['main', 'feature', 'HEAD']) {
  test(`the records directory is denied with ${branch} checked out`, async ($, on) => {
    createWorld(on, { branch }, { symlinks: { '/tmp/records': common }, ignored: [`${common}/working-agreement/x`] })
    for (const path of [`${common}/working-agreement/x`, '/tmp/records/working-agreement/new/x']) {
      const result = await $.tool.call(buildWriteCall(path))
      expect(result.deny).toContain("cannot write the mod's records")
      expect(result.deny).toContain('/flow approve')
    }
    expect((await $.tool.call(buildWriteCall(`${common}/working-agreement-backup/x`))).deny).toBeUndefined()
  })
}

test('detached HEAD at the default branch commit passes', async ($, on) => {
  createWorld(on, { branch: 'HEAD', ahead: 0 })
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
})

for (const flow of [null, 'large-feature', 'small-feature', 'fix']) {
  test(`flow ${flow} and unavailable GitHub do not gate feature-branch writes`, async ($, on) => {
    createWorld(on, { branch: 'feature' }, { session: { ...noFlow, flow }, failing: 'gh', unit: { skills: [] } })
    expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
  })
}

test('layer-2 denies count as blocked edits without changing the record format', async ($, on) => {
  const world = createWorld(on, { branch: 'main' })
  await $.tool.call(buildWriteCall('src/a.ts'))
  await world.clock.settle()
  expect(await readFlowStatus($)).toContain('Blocked')
  expect(world.sessions.get('sid')?.blocked.edits).toBe(1)
})

test('a default-branch unit asks to re-declare on its branch', async ($, on) => {
  createWorld(on, { branch: 'main' })
  const context = await readPromptContext($)
  expect(context).toContain('current step: Code')
  expect(context).toContain("re-declare on the unit's branch")
})
