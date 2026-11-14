import type { EnginePort } from './engine-port'

/**
 * Shares repeated read-only process responses during one observation, including settled reads; a failed gh read is shared only while it runs.
 * Index captures and record writes still run on every call, preserving their allocation sequence.
 * @param port - The engine calls for this observation.
 * @param isGithubCacheOnly - Whether the observation answers from cached GitHub facts alone.
 * @returns A port whose cache ends with this observation.
 */
export function createReadPort(port: EnginePort, isGithubCacheOnly = false): EnginePort {
  const readsByCommand = new Map<string, ReturnType<EnginePort['processes']['run']>>()
  return { ...port, ...isGithubCacheOnly ? { isGithubCacheOnly: true as const } : {}, processes: { ...port.processes, run: (argv, options) => {
    const gitArgs = argv.filter(arg => arg !== '--no-optional-locks')
    const gitCommand = argv[0] === 'git' ? gitArgs[gitArgs[1] === '-C' ? 3 : 1] : undefined
    const isGitRead = gitCommand !== undefined && ['rev-parse', 'rev-list', 'merge-base', 'cat-file', 'diff', 'status'].includes(gitCommand)
      || gitCommand === 'worktree' && argv.at(-2) === 'list' && argv.at(-1) === '--porcelain'
    if (argv[0] !== 'gh' && !isGitRead) return port.processes.run(argv, options)
    const key = JSON.stringify([argv, options])
    const held = readsByCommand.get(key)
    if (held) return held
    const read = port.processes.run(argv, options)
    readsByCommand.set(key, read)
    // why: a failed gh read is never shared once it settled, so a retry of it reads GitHub again.
    const forget = (): void => { if (readsByCommand.get(key) === read) readsByCommand.delete(key) }
    if (argv[0] === 'gh') void read.then(output => { if (output.exitCode !== 0) forget() }, forget)
    return read
  } } }
}
