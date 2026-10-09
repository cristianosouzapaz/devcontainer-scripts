import { expect, test } from 'claude-code/testing'

import { bashCall } from './helpers'
import { world } from './world'

// On the default branch every repository write is denied, so a deny shows the command was read as one.
const writes = [
  'echo x > a.txt',
  'echo x >> a.txt',
  'echo x 2> err.log',
  'echo x >/repo/a.txt',
  'ls && echo x > a.txt',
  'echo x | tee a.txt',
  'echo x | tee -a /tmp/log a.txt',
  'cp /tmp/x a.txt',
  'mv /tmp/x src/a.ts',
  'sed -i s/a/b/ a.txt',
  'sed -i.bak s/a/b/ a.txt',
  'sudo tee a.txt',
  'cat <<EOF > a.txt\nbody\nEOF',
]
const others = [
  'cat a.txt',
  'sed s/a/b/ a.txt',
  'echo "a > b"',
  'echo x > /tmp/a',
  'make 2>&1',
  'echo x > $OUT',
  'echo x > ~/a',
  'cp a.txt /tmp/b',
  'cat <<EOF\na > b.txt\nEOF',
]

test('a shell command that writes inside the repository is judged; one that reads or writes elsewhere is not', async ($, on) => {
  world(on, { branch: 'main' })
  for (const command of writes) {
    expect((await $.tool.call(bashCall(command))).deny, command).toContain('default branch')
  }
  for (const command of others) {
    expect((await $.tool.call(bashCall(command))).deny, command).toBeUndefined()
  }
})
