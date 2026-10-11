import type { Step } from './flow-definitions'
import type { Session } from './records'

/**
 * Lists the lines a PR body must carry but does not.
 *
 * @param requires - What the PR step requires of the body.
 * @param session - The session, which holds the declared issues and the followed-up issue.
 * @param body - The PR body text.
 * @returns The missing lines as displayed, empty when the body is complete.
 */
export function listMissingLines(requires: Step['requires'], session: Session, body: string): string[] {
  const hasLine = (word: string, number: number) => new RegExp(`\\b${word}\\s+#${number}\\b`, 'i').test(body)
  if (requires === 'closes') return session.issues.filter(number => !hasLine('Closes', number)).map(number => `Closes #${number}`)
  if (session.followUp === undefined) return []
  if (requires === 'refs') return hasLine('Refs', session.followUp) ? [] : [`Refs #${session.followUp}`]
  return requires === 'linked' && !hasLine('(?:closes|refs|fixes|resolves)', session.followUp) ? [`Closes|Refs|Fixes|Resolves #${session.followUp}`] : []
}
