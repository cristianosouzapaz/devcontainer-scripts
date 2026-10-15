import { expect, test } from 'claude-code/testing'

import { buildBashCall } from '../support/builders'
import { setPermissionMode } from '../support/helpers'
import { createWorld } from '../support/world'

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
  'echo x > ~/a',
  'cp a.txt /tmp/b',
  'cp a.txt \\\n  /tmp/b',
  'cat <<EOF\na > b.txt\nEOF',
]
// Writes the shell runs as code of its own, or behind a prefix or a program path.
const nestedWrites = [
  "bash -c 'echo x > a.txt'",
  "sh -c 'cd src && tee a.ts'",
  "eval 'echo x > a.txt'",
  'echo "$(echo x > a.txt)"',
  'command cp /tmp/x a.txt',
  'timeout 5 /bin/mv /tmp/x a.txt',
]
// Targets the shell resolves at run time, which the line does not name.
const unresolvedWrites = [
  'echo x > $OUT',
  'echo x > "${DIR}/a.txt"',
  'cd $X && echo x > f.txt',
  'cd - && echo x > f.txt',
  'echo x > `pwd`/a.txt',
]
// Code an interpreter runs from the line or from stdin, which may write any file.
const interpreterWrites = [
  "python3 - <<'EOF'\nopen('a.sh', 'w').write('x')\nEOF",
  "python3 -c \"open('a.sh', 'w').write('x')\"",
  "python -c 'pass'",
  "cat fix.py | python3",
  "node -e \"require('fs').writeFileSync('a.sh', 'x')\"",
  "node --eval '1'",
  "perl -pi -e 's/a/b/' a.sh",
  "perl -e 'print 1'",
  "ruby -e 'File.write(\"a.sh\", \"x\")'",
  "awk -i inplace '{print}' a.sh",
  "cd src && python3 -c 'pass'",
]
// A script file is not code the line holds: its writes are seen once it ran.
const scriptRuns = ['python3 script.py', 'node script.js', 'perl script.pl', 'python3 -m pytest', "awk '{print}' a.sh"]

test('a shell command that writes inside the repository is judged; one that reads or writes elsewhere is not', async ($, on) => {
  createWorld(on, { branch: 'main' })
  for (const command of writes) {
    expect((await $.tool.call(buildBashCall(command))).deny, command).toContain('default branch')
  }
  for (const command of others) {
    expect((await $.tool.call(buildBashCall(command))).deny, command).toBeUndefined()
  }
})

test('a write inside sh -c, eval, a substitution, or behind a prefix or a program path is judged', async ($, on) => {
  createWorld(on, { branch: 'main' })
  for (const command of nestedWrites) {
    expect((await $.tool.call(buildBashCall(command))).deny, command).toContain('default branch')
  }
})

test('a relative target is resolved against the last literal cd before it', async ($, on) => {
  createWorld(on, { branch: 'main' })
  for (const command of ['cd /tmp/scratch && echo x > f.txt', 'pushd /tmp && cp /repo/a b', '(cd src && make) ; cd /tmp ; echo x > f']) {
    expect((await $.tool.call(buildBashCall(command))).deny, command).toBeUndefined()
  }
  for (const command of ['cd /repo/src && echo x > f.txt', 'cd src; echo x > f.txt', '(cd /tmp && make) && echo x > f.txt', "bash -c 'cd /tmp' && echo x > f.txt"]) {
    expect((await $.tool.call(buildBashCall(command))).deny, command).toContain('default branch')
  }
})

test('from a working directory outside the repository, a cd into it makes the write a repository write', async ($, on) => {
  createWorld(on, { branch: 'main' }, { cwd: '/tmp' })
  expect((await $.tool.call(buildBashCall('echo x > f.txt'))).deny).toBeUndefined()
  expect((await $.tool.call(buildBashCall('cd /repo && echo x > f.txt'))).deny).toContain('default branch')
})

test('a target the shell resolves at run time is judged as a repository write', async ($, on) => {
  createWorld(on, { branch: 'main' })
  for (const command of unresolvedWrites) {
    expect((await $.tool.call(buildBashCall(command))).deny, command).toContain('default branch')
  }
  // An absolute target stays resolved after a cd the line cannot follow.
  expect((await $.tool.call(buildBashCall('cd $X && echo x > /tmp/f'))).deny).toBeUndefined()
})

test('a target named through a literal assignment opening the line is resolved; one the line may change stays a repository write', async ($, on) => {
  createWorld(on, { branch: 'main' })
  for (const command of ['S=/tmp/s; rm -rf $S/mod && mkdir -p $S/mod && cp -a /repo/m/. $S/mod/', 'export S=/tmp/s && echo x > "${S}/a"']) {
    expect((await $.tool.call(buildBashCall(command))).deny, command).toBeUndefined()
  }
  for (const command of ['S=src; echo x > $S/a', 'S=/tmp/s; S=src; echo x > $S/a', "S=/tmp/s; sh -c 'echo x > $S/a'"]) {
    expect((await $.tool.call(buildBashCall(command))).deny, command).toContain('default branch')
  }
})

test('an interpreter running code from the line or from stdin is judged as a repository write; one running a script file is not', async ($, on) => {
  createWorld(on, { branch: 'main' })
  for (const command of interpreterWrites) {
    expect((await $.tool.call(buildBashCall(command))).deny, command).toContain('default branch')
  }
  for (const command of scriptRuns) {
    expect((await $.tool.call(buildBashCall(command))).deny, command).toBeUndefined()
  }
})

test('an unresolved target asks where a repository write asks, and is denied in a mode that never asks', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: { info: { 1: { title: 'feat', labels: [] } } } })
  await setPermissionMode($, 'default')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'echo x > $OUT' } })).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'echo x > /tmp/a' } })).decision).toBe('allow')
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(buildBashCall('echo x > $OUT'))).deny).toContain('Grill not done')
})
