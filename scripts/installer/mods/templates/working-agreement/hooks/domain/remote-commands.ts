import type { ConfigOrigin, PromptOrigin } from 'claude-code'

/** The `/config` key of the setting that lets the user's human-only `/flow` commands arrive through Remote Control. */
export const allowRemoteCommandsKey = 'working-agreement.allowRemoteCommands'

/** What a command's answer and its delegated-step record carry when it arrived through Remote Control. */
export const remoteNote = ' (via Remote Control)'

/**
 * Tells why a change to the Remote Control setting is refused, or null when the user made it at the local terminal: a change from
 * Remote Control or a plugin, in either direction, would let a phone or an agent widen who issues the user's commands.
 *
 * @param origin - Where the `config.set` came from.
 * @returns The refusal, or null.
 */
export function refuseRemoteSettingChange(origin: ConfigOrigin): string | null {
  return origin.kind === 'composer' ? null
    : `${allowRemoteCommandsKey} changes only at the local terminal's /config; this change came from ${origin.kind === 'plugin' ? `plugin ${origin.name}` : 'Remote Control'}.`
}

/**
 * Tells why a human-only `/flow` subcommand from this origin is refused, or null when it is accepted: typed at the local terminal,
 * or through Remote Control while the user turned the setting on. Every other origin is an agent's or a relay's and never issues it.
 *
 * @param subcommand - The `/flow` subcommand.
 * @param origin - Where the run came from.
 * @param isRemoteAllowed - Whether the setting is on, read live, or null when it could not be read; only consulted for a Remote Control origin.
 * @returns The refusal, naming the origin, or null.
 */
export async function refuseOrigin(subcommand: string, origin: PromptOrigin, isRemoteAllowed: () => Promise<boolean | null>): Promise<string | null> {
  if (origin.kind === 'composer') return null
  if (origin.kind === 'bridge') {
    const isAllowed = await isRemoteAllowed()
    if (isAllowed === null) return `/flow ${subcommand} arrived through Remote Control: ${allowRemoteCommandsKey} could not be read, so it counts as off.`
    return isAllowed ? null
      : `/flow ${subcommand} arrived through Remote Control, which is off: run it at the local terminal, or enable ${allowRemoteCommandsKey} there.`
  }
  return `/flow ${subcommand} is the user's to run at the local terminal; it arrived from origin ${describeOrigin(origin)}.`
}

/**
 * Names an origin, with the channel server or plugin it carries.
 *
 * @param origin - Where the run came from.
 * @returns The origin's kind, followed by its server or plugin name when it has one.
 */
function describeOrigin(origin: PromptOrigin): string {
  if ('server' in origin) return `${origin.kind} (${origin.server})`
  if ('name' in origin && typeof origin.name === 'string') return `${origin.kind} (${origin.name})`
  return String(origin.kind)
}
