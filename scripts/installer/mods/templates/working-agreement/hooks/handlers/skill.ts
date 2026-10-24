import type { Args, EventResult, Frozen, Next } from 'claude-code'

import type { EnginePort } from '../core/engine-port'
import { refreshView } from '../core/pane-view'
import { readSession, updateUnits, writeSession } from '../core/record-store'
import { withRecordLock } from '../core/session-memory'
import { mergeSkills } from '../domain/records'

/**
 * Records a started skill for the turn and for the unit; before a flow is declared, the session keeps it until the declaration credits it to the unit.
 *
 * @param port - The engine calls.
 * @param event - The skill's prompt.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleSkillPrompt(port: EnginePort, event: Frozen<Args<'skill.prompt'>>, next: Next<'skill.prompt'>): Promise<EventResult<'skill.prompt'>> {
  const name = event.skill.split(':').at(-1) ?? event.skill
  await withRecordLock(async () => {
    const session = await readSession(port)
    if (!session.flow) {
      if (!session.skills?.includes(name)) await writeSession(port, { ...session, skills: mergeSkills(session.skills ?? [], [name]) })
      return
    }
    await updateUnits(port, session, unit => ({ ...unit, skills: mergeSkills(unit.skills, [name]) }))
    await refreshView(port, true)
  })
  return next(event)
}
