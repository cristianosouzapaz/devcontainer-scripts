import { commandName, shellNames } from './bash-guards'

// why: A shell's exit status is its script's last command, so a pipe, list, background job, redirection, conditional
// or substitution can report a status the tests never returned; only one command, after at most one cd, is left.
const shell = new RegExp(`^(${shellNames})$`)
const commandFlag = /^-[a-z]*c[a-z]*$/i
const cdPrefix = /^\s*cd\s+[^\s|;&<>$`()]+\s*&&/
const masking = /[|;&<>$`()\n]/
const conditionals = new Set(['if', 'test', '[', '[[', '!', 'while', 'until', 'for', 'case'])

/** The refusal of a shell script whose exit status may not be the test command's own. */
export const wrapperRefusal = 'Refused: a shell -c script may hold one command, optionally after one `cd <dir> &&`; a pipe, `;`, `||`, `&`, ' +
  'a redirection, a conditional or a command substitution can mask the tests\' exit status. Run the test command directly ' +
  '(its argv, or sh -c "cd <dir> && <command>"); the result lists the failing test lines and names the run\'s log file — filter the output by reading that log, never through a pipe.'

/**
 * Tells whether an argv is a shell script that may report another exit status than its one test command's.
 * @param argv - The Diagnose command and arguments.
 * @returns Whether the run tool must refuse it.
 */
export function masksExitStatus(argv: string[]): boolean {
  if (!shell.test(commandName(argv[0] ?? ''))) return false
  const flag = argv.findIndex(arg => commandFlag.test(arg))
  if (flag < 0) return false
  const command = (argv[flag + 1] ?? '').replace(cdPrefix, '')
  return masking.test(command) || conditionals.has(command.trim().split(/\s+/)[0] ?? '') || command.trim() === ''
}
