import { findFlow, resolveUnitFlow } from '../domain/flow-definitions'
import type { EnginePort } from './engine-port'
import { locatePosition } from './position'
import { readDeclaration, readSession, readSessionMirrors } from './record-store'

/** The one form `expects` takes: the unit step the message was written for. */
const stepForm = /^step:([\w-]+)$/

/**
 * Judges a coordinator's `expects` before anything is sent: only `step:<id>`, on an assign or an inform, naming a step of the unit's declared flow.
 * A cancel never carries one, since it stops the unit whatever its step and its gate counts from arrival.
 * @param port - The engine calls.
 * @param issue - The unit's issue.
 * @param kind - The message's kind.
 * @param expects - The argument as given.
 * @returns Why it is refused, or null when it may be sent.
 */
export async function judgeExpects(port: EnginePort, issue: number, kind: string, expects: unknown): Promise<string | null> {
  if (expects === undefined) return null
  if (kind === 'cancel') return 'a cancel stops the unit whatever its step, so it never carries expects'
  const id = typeof expects === 'string' ? stepForm.exec(expects)?.[1] : undefined
  if (!id) return 'expects must be step:<id>, a step of the unit\'s declared flow'
  const record = (await readSessionMirrors(port)).map(mirror => mirror.session).find(session => !session.role && session.unit?.issues.includes(issue))
  const flow = record?.unit ? findFlow((await readDeclaration(port, record.unit))?.flow ?? null) : undefined
  if (!flow) return `#${issue}'s unit has no declared flow this session can read, so no step can be expected`
  // why: a child unit ends with Integrate in place of PR, and both are steps the unit may be expected at.
  const steps = new Set([...flow.steps, ...resolveUnitFlow(flow, true).steps].map(step => step.id))
  return steps.has(id) ? null : `${id} is not a step of #${issue}'s flow, whose steps are ${[...steps].join(', ')}`
}

/**
 * Tells whether a message's `expects` still holds for this session: empty always holds, `step:<id>` only while this session's current step is that one.
 * A step that cannot be read does not hold, so a message is never delivered on a guess.
 * @param port - The engine calls.
 * @param expects - The envelope's field.
 * @returns Whether it holds.
 */
export async function isExpectationHeld(port: EnginePort, expects: string): Promise<boolean> {
  if (!expects) return true
  const id = stepForm.exec(expects)?.[1]
  if (!id) return false
  const position = await locatePosition(port, await readSession(port), true).catch(() => null)
  return position?.current?.step.id === id
}
