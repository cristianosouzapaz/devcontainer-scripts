import { runsVerify, shellWords } from './shell'

/** A herdr verify launch: the pane it runs in and the id of its exit marker. */
export interface HerdrLaunch { pane: string; id: string }

// The words of the command's first `herdr pane <sub>` segment after the subcommand, or null.
function herdrPane(command: string, sub: string): string[] | null {
  for (const seg of shellWords(command)) {
    const w = seg.map(t => t.text)
    if (w[0] === 'herdr' && w[1] === 'pane' && w[2] === sub) return w.slice(3)
  }
  return null
}

/**
 * Reads a `herdr pane run <pane> <command>` call that launches the verify command and prints a per-launch
 * `__EXIT_<id>=$?__` marker (the id is `[A-Za-z0-9]+`, so output already in the pane cannot be mistaken for this run).
 *
 * @param command - The command line.
 * @param verifyCmd - The repository's verify command.
 * @returns The pane id and the marker id, or null when the call is anything else.
 */
export function herdrVerifyLaunch(command: string, verifyCmd: string): HerdrLaunch | null {
  const [pane, ...rest] = herdrPane(command, 'run') ?? []
  const inner = rest.join(' ')
  const id = /__EXIT_([A-Za-z0-9]+)=\$\?__/.exec(inner)?.[1]
  return pane && id && runsVerify(inner, verifyCmd) ? { pane, id } : null
}

/**
 * Lists the arguments of a `herdr pane wait-output` call (flags, their values and the pane id).
 *
 * @param command - The command line.
 * @returns The words after `wait-output`, or null when the call is anything else.
 */
export const herdrWaitArgs = (command: string): string[] | null => herdrPane(command, 'wait-output')
