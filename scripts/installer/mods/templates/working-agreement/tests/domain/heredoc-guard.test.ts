import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { noFlow, verifyFile } from '../support/builders'
import { buildScope, createWorld, markSpawned, scopeFile } from '../support/world'
import type { Options } from '../support/world'

const sessions: [string, Options, boolean][] = [
  ['a session with no flow', { session: noFlow }, false],
  ['a declared unit', { verifyFile }, false],
  ['a delegated unit', { verifyFile }, true],
]

// why: the command seen live, a Python script editing a Bats file whose stubs use <<'EOF', so line 4 ends the outer heredoc and Bash runs the rest of the body as shell.
const earlyEnd = [
  'python3 - <<\'EOF\'',
  's=open(\'t.bats\').read()',
  's=s.replace("""\tcat > "$fx/bin/corepack" <<\'EOF\'""","""\tcat > "$fx/bin/git" <<\'EOF\'',
  'EOF',
  '\tcat > "$fx/bin/corepack" <<\'EOF\'""",1)',
  'open(\'t.bats\',\'w\').write(s)',
  'EOF',
].join('\n')

const wellFormed = [
  ['a plain heredoc', 'cat > notes.txt <<EOF\nhello\nEOF'],
  ['a nested heredoc with a distinct delimiter', 'python3 - <<\'PY\'\ns = """cat > a <<\'EOF\'\nx\nEOF\n"""\nprint(s)\nPY'],
  ['a tab-stripped heredoc', 'cat <<-EOF\n\tx\n\tEOF'],
  ['a here-string', 'cat <<< "EOF"'],
] as const

for (const [session, options, isDelegated] of sessions) {
  test(`in ${session}, the Bash guard refuses a heredoc whose body holds its own delimiter, naming the line and the way out`, async ($, on) => {
    const world = createWorld(on, { branch: 'feat' }, { ...options })
    if (isDelegated) {
      world.files.set(scopeFile('coord'), buildScope('coord', [1]))
      markSpawned(world, [1])
    }
    const deny = (await $.tool.call({ tool: 'Bash', command: earlyEnd })).deny ?? ''
    expect(deny).toContain('closes at line 4')
    expect(deny).toContain('non-empty lines follow')
    expect(deny).toContain('Edit or Write')
    expect(deny).not.toContain('ends early')
  })
}

// contract: a line holding any character but space and tab after the close counts as following, since Bash runs it
test('the Bash guard counts a line holding only a carriage return as one that follows the close', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  const deny = (await $.tool.call({ tool: 'Bash', command: 'cat > notes.md <<EOF\nRun cat <<EOF here.\nEOF\n \t\n\r' })).deny ?? ''
  expect(deny).toContain('non-empty lines follow from line 5')
})

// contract: the refusal never claims a heredoc Bash may not open, nor that the lines after its close run as shell, which a later heredoc's body does not
test('the Bash guard words an opener it reads line by line as one that may not be real, and claims no shell run', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  const deny = (await $.tool.call({ tool: 'Bash', command: 'echo "a\ncat <<EOF\n<<EOF"\nEOF\nls' })).deny ?? ''
  expect(deny).toContain('reads as opening a heredoc')
  expect(deny).toContain('If it does, that heredoc closes at line 4')
  expect(deny).not.toContain('shell commands')
})

// contract: a body that only mentions its own delimiter's opener, with nothing after the closing line, is no early close
test('the Bash guard lets a body that only mentions <<EOF as text run', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  expect((await $.tool.call({ tool: 'Bash', command: 'cat > notes.md <<EOF\nRun cat <<EOF to start a heredoc.\nEOF' })).deny).toBeUndefined()
})

for (const [name, command] of wellFormed) {
  test(`the Bash guard lets ${name} through`, async ($, on) => {
    createWorld(on, { branch: 'feat' }, { session: noFlow })
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  })
}
