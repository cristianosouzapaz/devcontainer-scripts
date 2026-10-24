import type { Result } from '../lib/result'
import { fail } from '../lib/result'

/** The declaration call the user-owned follow-up command makes. */
export interface FollowUpPort { declareFollowUp: (issue: number) => Promise<Result<string>> }

/**
 * Parses the user-owned follow-up command.
 * @param port - The declaration call.
 * @param args - The issue argument.
 * @returns The declaration result or usage message.
 */
export async function runFollowUpCommand(port: FollowUpPort, args: string): Promise<Result<string>> {
  const issue = Number(args.replace('#', ''))
  return Number.isSafeInteger(issue) && issue > 0 ? port.declareFollowUp(issue) : fail('Usage: /flow follow-up #<n>.')
}
