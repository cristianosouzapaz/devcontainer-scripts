import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { recordDelegatedStep } from '../core/delegation'
import type { EnginePort } from '../core/engine-port'
import { refreshView } from '../core/pane-view'
import { readSession, updateSession, updateUnits } from '../core/record-store'
import { withRecordLock } from '../core/session-memory'
import { mergeUnique } from '../domain/records'

// The skills the coordinator may run for the user under delegation; the other user-step skills stay the user's.
const delegableSkills = ['to-spec', 'to-tickets']

/**
 * Records a started skill for the turn and for the unit; before a flow is declared, the session keeps it until the declaration credits it to the unit.
 * Only a skill the installer put in the user's skills counts: one a plugin, a server or the repository supplies under the same name proves no step.
 *
 * @param port - The engine calls.
 * @param event - The skill's prompt.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleSkillPrompt(port: EnginePort, event: Frozen<Args<'skill.prompt'>>, next: Next<'skill.prompt'>): Promise<EventResult<'skill.prompt'>> {
  if (event.source !== 'userSettings' || event.pluginName !== undefined) return next(event)
  const name = event.skill
  const hasFlow = await withRecordLock(async () => {
    const session = await readSession(port)
    if (!session.flow) {
      await updateSession(port, current => current.flow || current.skills?.includes(name) ? null : { ...current, skills: mergeUnique(current.skills ?? [], [name]) })
      return false
    }
    await updateUnits(port, session, unit => ({ ...unit, skills: mergeUnique(unit.skills, [name]) }))
    return true
  })
  if (!hasFlow) return next(event)
  if (delegableSkills.includes(name)) await bestEffort(port, 'delegated step record', () => recordDelegatedStep(port, `/${name}`), false)
  await refreshView(port, { isQuiet: true })
  return next(event)
}
