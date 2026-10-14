import { expect, test } from 'claude-code/testing'

import { readDirtyFiles } from '../../hooks/lib/git'
import type { ProcessPort } from '../../hooks/lib/process'

// Answers git status with `status` and hashes each file as `h:<path>`, exiting 128 on a file the tree lacks.
function buildProcesses(status: string, absent: string[] = []): ProcessPort {
  return {
    run: async argv => {
      if (argv[3] === 'status') return { exitCode: 0, stdout: status, stderr: '' }
      const paths = argv.slice(argv.indexOf('--') + 1)
      if (paths.some(path => absent.includes(path))) return { exitCode: 128, stdout: '', stderr: 'fatal: could not open' }
      return { exitCode: 0, stdout: paths.map(path => `h:${path}\n`).join(''), stderr: '' }
    },
  }
}

test('the dirty tree holds every changed, staged, untracked and deleted file, with a hash for each file the tree has', async () => {
  const status = ' M src/a.ts\0M  src/b.ts\0MM src/c.ts\0?? new dir/d.ts\0 D gone.ts\0D  staged-gone.ts\0A  added.ts\0'
  const read = await readDirtyFiles(buildProcesses(status), '/repo')
  expect(read).toEqual({
    isOk: true,
    value: {
      'src/a.ts': 'h:src/a.ts', 'src/b.ts': 'h:src/b.ts', 'src/c.ts': 'h:src/c.ts', 'new dir/d.ts': 'h:new dir/d.ts',
      'gone.ts': '', 'staged-gone.ts': '', 'added.ts': 'h:added.ts',
    },
  })
})

test('a clean tree reads as no files, and a file git cannot hash fails the read', async () => {
  expect(await readDirtyFiles(buildProcesses(''), '/repo')).toEqual({ isOk: true, value: {} })
  expect((await readDirtyFiles(buildProcesses(' M src/a.ts\0', ['src/a.ts']), '/repo')).isOk).toBe(false)
})
