import type { EnginePort } from './engine-port'

/**
 * Shares repeated read-only process responses during one observation, including settled reads.
 * Index captures and record writes still run on every call, preserving their allocation sequence.
 * @param port - The engine calls for this observation.
 * @returns A port whose cache ends with this observation.
 */
export function createReadPort(port: EnginePort): EnginePort {
  const readsByCommand = new Map<string, ReturnType<EnginePort['processes']['run']>>()
  return { ...port, processes: { ...port.processes, run: (argv, options) => {
    const gitArgs = argv.filter(arg => arg !== '--no-optional-locks')
    const gitCommand = argv[0] === 'git' ? gitArgs[gitArgs[1] === '-C' ? 3 : 1] : undefined
    const isGitRead = gitCommand !== undefined && ['rev-parse', 'rev-list', 'merge-base', 'cat-file', 'diff', 'status'].includes(gitCommand)
      || gitCommand === 'worktree' && argv.at(-2) === 'list' && argv.at(-1) === '--porcelain'
    if (argv[0] !== 'gh' && !isGitRead) return port.processes.run(argv, options)
    const key = JSON.stringify([argv, options])
    const read = readsByCommand.get(key) ?? port.processes.run(argv, options)
    readsByCommand.set(key, read)
    return read
  } } }
}
