import type { Attempt, AttemptStatus, EnteredPrompt, KeptStart, LegacyEvidence, Notice, PendingStart, ProcessHost, ProcessState, ProcessTurn, Receipt } from '../../types'
import { formatError } from '../lib/result'
import { isFiniteNumber, isRecord, isStringArray } from '../lib/guards'
import { describeProcessStateFailure, unknownProcessShape as unknownShape } from '../domain/liveness'
import { describeStartTarget } from '../domain/instruction'
import type { EnginePort } from './engine-port'
import { clearFault, raiseFault, readFault } from './fault-registry'
import { moduleState } from '../lib/module-state'
import { sessionMemory } from './session-memory'

/** The host holds no process state, as in a new process. */
interface AbsentValue { kind: 'absent' }

/** The host holds a process state this module can decode, of its own shape or of the shape an earlier version of it wrote. */
interface HeldState { kind: 'held'; state: ProcessState }

/** The host holds a value this module does not know: another shape, or this shape's name with a field missing or of another type. */
interface ForeignValue { kind: 'foreign' }

/** What the host holds. */
type HeldValue = AbsentValue | HeldState | ForeignValue

/** How this module's process state began: kept across a reload of the mod, new with its process, or not known. */
type ProcessOrigin = 'reload' | 'process' | 'unknown'

/** Whether a read or a write of the process state failed, which the pane names apart. */
type FaultKind = 'read' | 'write'

/** The process state a session start adopted, and how it began. */
export interface ProcessStart { state: ProcessState | null; origin: ProcessOrigin }

/**
 * What the records an earlier module left say, for a session start that finds no process state held: the process the host record names,
 * null for none, the activity record's turn, epoch and the turn it names, null for no record, each `unread` when it could not be read,
 * and this process's own identity, null when it could not be stamped.
 */
export interface LegacyReading { host: ProcessHost | null | 'unread'; activity: { isTurn: boolean; epoch: number; turnId?: string } | null | 'unread'; own: ProcessHost | null }

/** How the records an earlier module left settle: whether a turn of this very process runs, and the epoch they reached; or still unresolved. */
export type LegacySettlement = { kind: 'settled'; isSameProcess: boolean; isTurn: boolean; epoch: number } | { kind: 'unresolved'; evidence: LegacyEvidence; epoch: number }

/** Why an owned change to the process state was refused, with nothing written. */
export type OwnedRefusal = 'not-owner' | 'busy' | 'held' | 'gone'

/** What a step decided on the current state: the state it writes and its value, or why it is refused. */
export type OwnedStep<T> = { kind: 'won'; state: ProcessState; value: T } | { kind: OwnedRefusal }

/** What one run of a compare-and-set's step decided: the state it writes and its typed result. */
export interface Transaction<R> { state: ProcessState; result: R }

/** How an owned change ended: won, refused with nothing written, or unknown, as its read or write failed. */
export type OwnedTransition<T> = { kind: 'won'; value: T; state: ProcessState } | { kind: OwnedRefusal } | { kind: 'unknown'; error: string }

// why: the id of this mod load, which every owned change names, and which a reload starts over; whether its session start opened an adoption of the process state not settled yet, by an adoption or a turn change, since an absent state is never usable until then; the load the state named at this load's first look, which it replaces, undefined before that look; whether a write recording this load landed, after which only a newer load replaces it; and the generation this load seeds a state with, so a seed of its own whose answer was lost is never read back as a state a reload kept.
const load = moduleState(() => ({ id: crypto.randomUUID(), isAdopting: false, predecessor: undefined as string | null | undefined, isRecorded: false, seed: crypto.randomUUID(), seedOrigin: null as ProcessOrigin | null }))

/** The process state of a process whose host holds none: no turn, no entering prompt, no kept start and no wait, in no named process. */
const emptyProcessState: ProcessState = {
  shape: 'v2', generation: '', epoch: 0, turn: null, prompt: null, pendingStart: null, pendingStarts: [], verifyAskedBlob: null, approvalWait: null, wokenBlobs: [],
  pendingWake: null, turnEndKeys: [],
}

/** The fields the decoding rebuilds, or that only the shape before attempts held, which a decoded state carries only as rebuilt. */
const decodedKeys = new Set(['unknownStarts', 'unknownOverflow', 'unknownOverflowShown', 'flightEvidence', 'legacyUnresolved', 'wakeSubmitted', 'legacy', 'attempts'])

/** How many starts the session keeps at once; one more is refused and named, never dropped. */
const keptStartLimit = 8

/** Why a write is refused while this load has not adopted the process state, so nothing is ever written over an absent one before then. */
const unstartedCause = 'the process state is not started yet: its first read at the session start failed, and the tick tries it again'

/**
 * Reads the id of this mod load.
 * @returns The id.
 */
export const readLoadId = (): string => load.id

/**
 * Tells whether this load holds no adoption of the process state open: its session start opens one before it registers its tick or its
 * commands, and an adoption or a turn change settles it.
 * @returns Whether none is open.
 */
export const isProcessStarted = (): boolean => !load.isAdopting

/**
 * Opens this load's adoption of the process state, as its session start does first, so neither its tick nor a command takes an absent
 * state for an empty one before the adoption read the records an earlier module left.
 */
export function openAdoption(): void {
  load.isAdopting = true
}

/**
 * Reads the load the process state named at this load's first look, which this load replaces.
 * @returns The load, null for none, or undefined before the first look.
 */
export const readPredecessor = (): string | null | undefined => load.predecessor

/**
 * Tells whether a write recording this load in the process state landed.
 * @returns Whether it did.
 */
export const isLoadRecorded = (): boolean => load.isRecorded

/**
 * Tells whether a state shows this load replaced: it was recorded once, and the state records another load, which only a newer load, or
 * one whose first look came late, does.
 * @param state - The process state.
 * @returns Whether it does.
 */
export const isReplacedIn = (state: ProcessState): boolean => load.isRecorded && state.loadId !== undefined && state.loadId !== load.id

/**
 * Notes that a write recording this load landed, which clears the fault a failed one raised.
 * @param loadId - The load the write recorded, read before its first await.
 */
export function noteLoadRecorded(loadId: string): void {
  if (load.id !== loadId) return
  load.isRecorded = true
  clearFault('load-id')
}

/**
 * Notes the load the process state named at this load's first look, once.
 * @param loadId - This load, read before the look's first await.
 * @param predecessor - The load the state named, null for none.
 */
function notePredecessor(loadId: string, predecessor: string | null): void {
  if (load.id === loadId && load.predecessor === undefined) load.predecessor = predecessor
}

/**
 * Tells whether a value is a running turn.
 * @param value - The value.
 * @returns Whether it is.
 */
const isTurn = (value: unknown): value is ProcessTurn => isRecord(value) && typeof value.id === 'string' && typeof value.hasSent === 'boolean'
  && typeof value.isInformOnly === 'boolean' && typeof value.isEmptyDoorbell === 'boolean'

/**
 * Tells whether a value is an entering prompt.
 * @param value - The value.
 * @returns Whether it is.
 */
const isPrompt = (value: unknown): value is EnteredPrompt => isRecord(value) && isFiniteNumber(value.enteredAt)
  && typeof value.isInformOnly === 'boolean' && typeof value.isEmptyDoorbell === 'boolean' && (value.isClaim === undefined || typeof value.isClaim === 'boolean')

/**
 * Tells whether a value is a kept start.
 * @param value - The value.
 * @returns Whether it is.
 */
const isStart = (value: unknown): value is PendingStart => isRecord(value) && (value.kind === 'step' ? typeof value.lead === 'string'
  : value.kind === 'coordinate' ? typeof value.text === 'string'
    : value.kind === 'delegate' && Array.isArray(value.issues) && value.issues.every(isFiniteNumber) && typeof value.instructions === 'string')

/**
 * Tells whether a value names a kind of start.
 * @param value - The value.
 * @returns Whether it does.
 */
const isStartKind = (value: unknown): value is PendingStart['kind'] => value === 'step' || value === 'coordinate' || value === 'delegate'

/**
 * Tells whether a value is what is known of an attempt.
 * @param value - The value.
 * @returns Whether it is.
 */
const isAttemptStatus = (value: unknown): value is AttemptStatus => isRecord(value) && (value.kind === 'pending' || value.kind === 'entered'
  || (value.kind === 'unknown' || value.kind === 'dropped') && typeof value.cause === 'string')

/**
 * Tells whether a value is an attempt.
 * @param value - The value.
 * @returns Whether it is.
 */
const isAttempt = (value: unknown): value is Attempt => isRecord(value) && typeof value.id === 'string' && typeof value.owner === 'string'
  && (value.route === 'start' || value.route === 'wake' || value.route === 'doorbell') && typeof value.subject === 'string' && isStartKind(value.kind)
  && typeof value.label === 'string' && isFiniteNumber(value.at) && isFiniteNumber(value.epoch) && isAttemptStatus(value.status)

/**
 * Tells whether a value is a notice of an obligation the mod ended.
 * @param value - The value.
 * @returns Whether it is.
 */
const isNotice = (value: unknown): value is Notice => isRecord(value) && typeof value.id === 'string' && typeof value.subject === 'string'
  && (value.route === 'start' || value.route === 'wake' || value.route === 'doorbell') && isStartKind(value.kind) && typeof value.label === 'string' && typeof value.cause === 'string'
  && (value.outcome === undefined || value.outcome === 'entered' || value.outcome === 'dropped') && (value.rev === undefined || typeof value.rev === 'string')
  && (value.established === undefined || isRecord(value.established) && isFiniteNumber(value.established.entered) && isFiniteNumber(value.established.dropped))

/**
 * Tells whether a value is a receipt the process state keeps.
 * @param value - The value.
 * @returns Whether it is.
 */
const isReceipt = (value: unknown): value is Receipt => isRecord(value) && typeof value.id === 'string' && typeof value.subject === 'string'
  && (value.route === 'start' || value.route === 'wake' || value.route === 'doorbell') && isStartKind(value.kind) && typeof value.label === 'string'
  && (value.outcome === 'entered' || value.outcome === 'dropped')

/**
 * Tells whether a value is a process a host record names.
 * @param value - The value.
 * @returns Whether it is.
 */
const isHost = (value: unknown): value is ProcessHost => isRecord(value) && typeof value.pidns === 'string' && isFiniteNumber(value.pid) && typeof value.pidStart === 'string'
  && typeof value.bootId === 'string'

/**
 * Tells whether a value is what an earlier version's records said.
 * @param value - The value.
 * @returns Whether it is.
 */
const isLegacy = (value: unknown): value is LegacyEvidence => isRecord(value) && (value.host === null || value.host === 'unread' || isHost(value.host))
  && (value.activity === 'unread' || isRecord(value.activity) && typeof value.activity.isTurn === 'boolean' && isFiniteNumber(value.activity.epoch))

/**
 * Tells whether a value is a string or null.
 * @param value - The value.
 * @returns Whether it is.
 */
const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string'

/**
 * Tells whether a value is a start the shape before attempts kept, with the mark of the delivery that held it, if any.
 * @param value - The value.
 * @returns Whether it is.
 */
const isEarlierKeptStart = (value: unknown): value is { id: string; start: PendingStart; inFlight?: { loadId: string; delivery: string; at: number; epoch?: number; isSubmitted?: boolean } } =>
  isRecord(value) && typeof value.id === 'string' && isStart(value.start) && (value.inFlight === undefined || isRecord(value.inFlight)
    && typeof value.inFlight.delivery === 'string' && typeof value.inFlight.loadId === 'string' && isFiniteNumber(value.inFlight.at)
    && (value.inFlight.epoch === undefined || isFiniteNumber(value.inFlight.epoch))
    && (value.inFlight.isSubmitted === undefined || typeof value.inFlight.isSubmitted === 'boolean'))

/**
 * Tells whether the fields a process state of either shape shares are all of their type.
 * @param value - The value.
 * @returns Whether they are.
 */
const hasCommonFields = (value: Record<string, unknown>): boolean => value.shape === 'v2' && typeof value.generation === 'string' && isFiniteNumber(value.epoch)
  && (value.turn === null || isTurn(value.turn)) && (value.prompt === null || isPrompt(value.prompt)) && (value.pendingStart === null || isStart(value.pendingStart))
  && (value.pendingStarts === undefined || Array.isArray(value.pendingStarts) && value.pendingStarts.every(isEarlierKeptStart))
  && (value.attempts === undefined || Array.isArray(value.attempts) && value.attempts.every(isAttempt))
  && (value.legacy === undefined || isLegacy(value.legacy)) && (value.loadId === undefined || typeof value.loadId === 'string')
  && (value.notices === undefined || Array.isArray(value.notices) && value.notices.every(isNotice)) && (value.receipts === undefined || Array.isArray(value.receipts) && value.receipts.every(isReceipt)) && (value.endedTurns === undefined || isStringArray(value.endedTurns))
  && (value.attempts === undefined || (value.attempts as Attempt[]).every(attempt => attempt.digest === undefined || typeof attempt.digest === 'string'))
  && (value.loadBeat === undefined || isFiniteNumber(value.loadBeat))
  && isNullableString(value.verifyAskedBlob) && isNullableString(value.approvalWait) && isStringArray(value.wokenBlobs) && isNullableString(value.pendingWake)
  && isStringArray(value.turnEndKeys) && (value.auditUnrecorded === undefined || isRecord(value.auditUnrecorded) && Object.values(value.auditUnrecorded).every(reason => typeof reason === 'string'))

/**
 * Tells whether the fields only the shape before attempts kept are each absent or of their type.
 * @param value - The value.
 * @returns Whether they are.
 */
const hasEarlierFields = (value: Record<string, unknown>): boolean =>
  (value.unknownStarts === undefined || Array.isArray(value.unknownStarts) && value.unknownStarts.every(entry => isRecord(entry) && typeof entry.id === 'string'
    && typeof entry.cause === 'string' && isStartKind(entry.kind) && (entry.label === undefined || typeof entry.label === 'string')))
  && (value.unknownOverflow === undefined || isFiniteNumber(value.unknownOverflow)) && (value.unknownOverflowShown === undefined || isFiniteNumber(value.unknownOverflowShown))
  && (value.flightEvidence === undefined || Array.isArray(value.flightEvidence) && value.flightEvidence.every(entry => isRecord(entry) && typeof entry.delivery === 'string'
    && isStringArray(entry.ids) && (entry.outcome === 'confirmed' || entry.outcome === 'back' || isRecord(entry.outcome) && typeof entry.outcome.cause === 'string')))
  && (value.legacyUnresolved === undefined || typeof value.legacyUnresolved === 'boolean') && (value.wakeSubmitted === undefined || isNullableString(value.wakeSubmitted))

/**
 * Decodes what the host holds into this module's shape. A state the shape before attempts wrote keeps its queue order and every outcome
 * it held: a start an earlier load marked in flight becomes an attempt of that load, settled by the evidence that load handed over, or
 * unknown without it; a start that left the keeping as unknown, and the count of more, stay unknown attempts; a wake marked submitted is an
 * unknown attempt; an unread earlier activity record stays unresolved. Nothing of it is dropped unsaid.
 * @param value - The host's value.
 * @returns The state, or null when it is not a process state this module knows.
 */
export function decodeProcessState(value: unknown): ProcessState | null {
  if (!isRecord(value) || !hasCommonFields(value) || !hasEarlierFields(value)) return null
  const raw = value as Record<string, unknown> & { pendingStarts?: unknown[]; unknownStarts?: { id: string; cause: string; kind: PendingStart['kind']; label?: string }[];
    flightEvidence?: { delivery: string; ids: string[]; outcome: 'confirmed' | 'back' | { cause: string } }[] }
  const earlier = (raw.pendingStarts ?? []).filter(isEarlierKeptStart)
  const evidence = raw.flightEvidence ?? []
  const marked: Attempt[] = earlier.flatMap(kept => {
    const flight = kept.inFlight
    if (!flight) return []
    const outcome = evidence.find(entry => entry.delivery === flight.delivery && entry.ids.includes(kept.id))?.outcome
    const status: AttemptStatus = outcome === 'confirmed' ? { kind: 'entered' } : outcome === 'back' ? { kind: 'dropped', cause: 'put back by the earlier load that held it, as it never entered' }
      : { kind: 'unknown', cause: typeof outcome === 'object' ? outcome.cause : flight.isSubmitted ? 'submitted by an earlier load of the mod, so whether it entered is unknown'
        : 'held by an earlier load of the mod, not known whether it entered' }
    return [{ id: `${flight.delivery}:${kept.id}`, owner: flight.loadId, route: 'start' as const, subject: kept.id, kind: kept.start.kind, label: describeStartTarget(kept.start), at: flight.at, epoch: flight.epoch ?? 0, status }]
  })
  const unknown: Attempt[] = (raw.unknownStarts ?? []).map(entry => ({ id: `unknown:${entry.id}`, owner: '', route: entry.id.startsWith('wake-') ? 'wake' as const : 'start' as const,
    subject: entry.id.startsWith('wake-') ? entry.id.slice('wake-'.length) : entry.id, kind: entry.kind, label: entry.label ?? '', at: 0, epoch: 0, status: { kind: 'unknown' as const, cause: entry.cause } }))
  const unshown = (isFiniteNumber(raw.unknownOverflow) ? raw.unknownOverflow : 0) - (isFiniteNumber(raw.unknownOverflowShown) ? raw.unknownOverflowShown : 0)
  const overflow: Attempt[] = unshown > 0 ? [{ id: 'unknown:overflow', owner: '', route: 'start', subject: '', kind: 'step', label: `${unshown} more start prompt${unshown === 1 ? '' : 's'}`, at: 0, epoch: 0,
    status: { kind: 'unknown', cause: 'kept by an earlier version of the mod only as a count, so whether each entered is unknown' } }] : []
  const wake: Attempt[] = typeof raw.wakeSubmitted === 'string' && raw.wakeSubmitted === raw.pendingWake ? [{ id: `wake:${raw.wakeSubmitted}`, owner: '', route: 'wake', subject: raw.wakeSubmitted,
    kind: 'step', label: 'the Verify approval wake prompt', at: 0, epoch: 0, status: { kind: 'unknown', cause: 'submitted by an earlier load of the mod, so whether it entered is unknown' } }] : []
  const legacy: LegacyEvidence | undefined = isLegacy(raw.legacy) ? raw.legacy : raw.legacyUnresolved === true ? { host: 'unread', activity: 'unread' } : undefined
  const attempts = [...Array.isArray(raw.attempts) ? raw.attempts as Attempt[] : [], ...marked, ...unknown, ...overflow, ...wake]
  const common = Object.fromEntries(Object.entries(raw).filter(([key]) => !decodedKeys.has(key))) as unknown as ProcessState
  return { ...common, pendingStarts: earlier.map(kept => ({ id: kept.id, start: kept.start })), ...attempts.length ? { attempts } : {}, ...legacy ? { legacy } : {} }
}

/**
 * Tells apart what the host holds.
 * @param value - The host's value, undefined when it holds none.
 * @returns What it is.
 */
const classify = (value: unknown): HeldValue => {
  if (value === undefined) return { kind: 'absent' }
  const state = decodeProcessState(value)
  return state ? { kind: 'held', state } : { kind: 'foreign' }
}

/**
 * Reads the process state at a decision point; it is never cached, since another module of this process, as the one a reload replaced,
 * may write it meanwhile.
 * @param port - The engine calls.
 * @returns The state, empty when the host holds none, or null when it cannot be read or holds a value this module does not know, which
 * no caller takes for idle; an empty state this load did not adopt yet is held by the gate.
 */
export async function readProcessState(port: EnginePort): Promise<ProcessState | null> {
  try {
    const held = classify(await port.readProcessState())
    if (held.kind !== 'foreign') notePredecessor(load.id, held.kind === 'held' ? held.state.loadId ?? null : null)
    noteFault(port, 'read', held.kind === 'foreign' ? unknownShape : null)
    return held.kind === 'held' ? held.state : held.kind === 'absent' ? emptyProcessState : null
  } catch (error) {
    noteFault(port, 'read', `its read failed: ${formatError(error)}`)
    return null
  }
}

/**
 * Settles what the records an earlier module left say: with every record read and this process stamped, a turn the very record of this
 * process holds is carried, and any other process ran none; while any of them is unknown, so is whether a turn runs.
 * @param reading - What the records said, and this process's identity.
 * @param known - What an earlier seeding already kept, which a later read never replaces.
 * @returns The settlement.
 */
export function settleLegacyReading(reading: LegacyReading, known?: LegacyEvidence): LegacySettlement {
  const host = known && known.host !== 'unread' ? known.host : reading.host
  const activity = known && known.activity !== 'unread' ? known.activity : reading.activity === null ? { isTurn: false, epoch: 0 } : reading.activity
  const epoch = activity === 'unread' ? 0 : activity.epoch
  // why: with no host record no module of this process recorded one, so it is another; a host record this process cannot compare against leaves it unknown.
  if (host === 'unread' || activity === 'unread' || host !== null && reading.own === null) return { kind: 'unresolved', evidence: { host, activity }, epoch }
  const own = reading.own
  const isSameProcess = !!host && !!own && host.pidns === own.pidns && host.pid === own.pid && host.pidStart === own.pidStart && host.bootId === own.bootId
  return { kind: 'settled', isSameProcess, isTurn: activity.isTurn, epoch }
}

/**
 * Adopts at a session start the process state the host holds, or seeds it when it holds none. A held state, or a value this module
 * does not know, means the mod reloaded in this process. With none, the records an earlier module left tell the rest: a record of this
 * very process is the one reload from a version that kept no process state, which carries the turn it recorded; any other is a new
 * process, where no turn runs. A record that cannot be read, or a process this one cannot stamp, leaves it unresolved, kept as evidence
 * the tick settles. A read that fails adopts nothing, and the tick runs this again, since an absent state is never usable before then.
 * @param port - The engine calls.
 * @param readLegacy - Reads what the earlier records say.
 * @returns The state, null when it cannot be read or written or holds a value this module does not know, and how it began.
 */
export async function startProcessState(port: EnginePort, readLegacy: () => Promise<LegacyReading>): Promise<ProcessStart> {
  load.isAdopting = true
  const read = await port.readProcessState().then(value => ({ value }), (error: unknown) => {
    noteFault(port, 'read', `its read failed: ${formatError(error)}`)
    return null
  })
  if (!read) return { state: null, origin: 'unknown' }
  const held = classify(read.value)
  // why: this load's first read that answers is its first look, the earliest it can learn the load it replaces; a later look could take a newer load, recorded since, for it.
  if (held.kind !== 'foreign') notePredecessor(load.id, held.kind === 'held' ? held.state.loadId ?? null : null)
  noteFault(port, 'read', held.kind === 'foreign' ? unknownShape : null)
  if (held.kind === 'foreign') return { state: null, origin: 'reload' }
  if (held.kind === 'held') {
    load.isAdopting = false
    return { state: held.state, origin: held.state.generation === load.seed ? load.seedOrigin ?? 'process' : 'reload' }
  }
  const reading = await readLegacy()
  const settled = settleLegacyReading(reading)
  // why: the module that recorded the carried turn may have seen a message sent, which is not known here, so its Stop asks for none.
  const turn: ProcessTurn | null = settled.kind === 'settled' && settled.isSameProcess && settled.isTurn ? { id: '', hasSent: true, isInformOnly: false, isEmptyDoorbell: false } : null
  // why: a turn the record shows ended stays ended, so a start of it that a replaced load writes late never sets it running.
  const ended = reading.activity && reading.activity !== 'unread' && !reading.activity.isTurn && reading.activity.turnId ? { endedTurns: [reading.activity.turnId] } : {}
  const origin: ProcessOrigin = settled.kind === 'unresolved' ? 'unknown' : settled.isSameProcess ? 'reload' : 'process'
  const seeded: ProcessState = { ...emptyProcessState, generation: load.seed, epoch: settled.epoch + 1, turn, ...ended, ...settled.kind === 'unresolved' ? { legacy: settled.evidence } : {} }
  const state = await writeProcessState(port, current => {
    const now = classify(current)
    if (now.kind === 'foreign') throw new Error(unknownShape)
    return now.kind === 'held' ? now.state : seeded
  })
  load.isAdopting = false
  // why: the origin is the one judged by the adoption whose seed landed; a second adoption of this load, as a tick's beside a start held up, read the records after this process stamped them, and would take its own seed for a reload.
  if (state.generation === load.seed) load.seedOrigin ??= origin
  return { state, origin: state.generation === load.seed ? load.seedOrigin ?? origin : 'reload' }
}

/**
 * Changes the process state with a compare-and-set that the host retries on a miss; a value this module does not know is never
 * overwritten, and neither is an absent one before this load adopted the process state, but by a turn change.
 * @param port - The engine calls.
 * @param change - Maps the current state to the next; it may run more than once.
 * @param isTurnChange - Whether the change is a turn's start, end or entering prompt.
 * @returns The state written, which a caller uses in place of reading it again in the same dispatch.
 * @throws When the host holds a value this module does not know, holds none before the start adopted it, or the write fails.
 */
export async function updateProcessState(port: EnginePort, change: (state: ProcessState) => ProcessState, isTurnChange = false): Promise<ProcessState> {
  const seeds = { isAbsent: false }
  const state = await writeProcessState(port, current => {
    const held = classify(current)
    if (held.kind === 'foreign') throw new Error(unknownShape)
    // why: a turn change settles by itself whether a turn runs, which is all an earlier version's records could tell, so it alone may seed the state, and the state it seeds is adopted.
    if (held.kind === 'absent' && load.isAdopting && !isTurnChange) throw new Error(unstartedCause)
    seeds.isAbsent = held.kind === 'absent'
    // why: every seed names its process with a generation of its own, or the session mirror's fence, and the activity record's, would take two processes for one.
    return change(held.kind === 'held' ? held.state : { ...emptyProcessState, generation: crypto.randomUUID() })
  })
  if (seeds.isAbsent) load.isAdopting = false
  return state
}

/**
 * Writes the process state, noting a failure where the pane and `/flow status` show it until a write succeeds.
 * @param port - The engine calls.
 * @param change - Maps the stored value to the next state.
 * @returns The state written.
 * @throws What the write threw, once noted.
 */
async function writeProcessState(port: EnginePort, change: (current: unknown) => ProcessState): Promise<ProcessState> {
  try {
    const state = await port.updateProcessState(change)
    noteFault(port, 'write', null)
    return state
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    noteFault(port, 'write', message === unknownShape || message === unstartedCause ? message : `its write failed: ${formatError(error)}`)
    throw error
  }
}

/**
 * Keeps why the process state cannot be read, or why the last change to it was not written, where the pane and `/flow status` show
 * it, and logs a new cause once. A read fault clears with the next good read; a write fault only with the next good write, since a
 * good read after it may show a state the failed change never reached.
 * @param port - The engine calls.
 * @param kind - Which operation.
 * @param cause - Why, or null once that operation succeeded.
 */
function noteFault(port: EnginePort, kind: FaultKind, cause: string | null): void {
  const key = kind === 'read' ? 'process-read' : 'process-write'
  if (cause !== null && cause !== readFault(key)) port.logDebug(`working-agreement: ${describeProcessStateFailure(kind, cause)}`)
  if (cause === null) clearFault(key)
  else raiseFault(key, { row: 'Process', text: describeProcessStateFailure(kind, cause), cause })
}

/**
 * Reads the starts the session keeps, oldest first: a single start a state written before the queue kept comes first.
 * @param state - The process state.
 * @returns The kept starts.
 */
export function readKeptStarts(state: ProcessState): KeptStart[] {
  return [...state.pendingStart ? [{ id: 'legacy', start: state.pendingStart }] : [], ...state.pendingStarts ?? []]
}

/**
 * Sets the starts the session keeps, leaving the single start of the older shape empty.
 * @param state - The process state.
 * @param starts - The starts, oldest first.
 * @returns The state with them.
 */
export const withKeptStarts = (state: ProcessState, starts: KeptStart[]): ProcessState => ({ ...state, pendingStart: null, pendingStarts: starts })

/** A keep whose write answered with a failure, after which the start may or may not be kept: the write may have landed and its answer been lost. */
export class UnknownKeepError extends Error {}

/**
 * Keeps a start behind those already kept, as the load the state records, or as the load that replaces it, which records itself in the
 * same write; a load a reload replaced keeps nothing. A full keeping refuses it, naming why, so no start is dropped unseen.
 * @param port - The engine calls.
 * @param owner - The load keeping it, read before the caller's first await.
 * @param kept - The start with its id.
 * @returns Once kept.
 * @throws An UnknownKeepError when the write answered with a failure, so whether it is kept is not known; an Error when the keeping is
 * full, or this load does not hold the state.
 */
export async function keepStart(port: EnginePort, owner: string, kept: KeptStart): Promise<void> {
  const outcome = await transitOwned<number>(port, owner, state => {
    const starts = readKeptStarts(state)
    return starts.length >= keptStartLimit ? { kind: 'won', state, value: starts.length } : { kind: 'won', state: withKeptStarts(state, [...starts, kept]), value: 0 }
  })
  // why: a step that refused a value this module does not know, or an absent state before the adoption, wrote nothing, so only another failure leaves the keep unknown.
  if (outcome.kind === 'unknown') throw outcome.error === unknownShape || outcome.error === unstartedCause ? new Error(outcome.error) : new UnknownKeepError(outcome.error)
  if (outcome.kind !== 'won') throw new Error('this load of the mod does not hold the session\'s process state: a reload replaced it, or it is still starting; run the command again')
  if (outcome.value) throw new Error(`${outcome.value} start prompts already wait for this session to be idle, the most it keeps`)
}

/**
 * Refuses a command that would keep a start prompt while the session already keeps the most it can, before the command applies, so
 * nothing changes. A keeping that cannot be read is not judged full: the command applies, and its keep reports why it failed.
 * @param port - The engine calls.
 * @returns The refusal, or null when the command may run.
 */
export async function refuseWithoutStartRoom(port: EnginePort): Promise<string | null> {
  const count = await readFullKeeping(port)
  return count === null ? null
    : `Refused, nothing changed: ${count} start prompts already wait for this session to be idle, the most it keeps. Run the command again once they are delivered; /flow status shows how many still wait on its Process row.`
}

/**
 * Reads whether the session keeps the most start prompts it can; a keeping that cannot be read is not judged full.
 * @param port - The engine calls.
 * @returns How many wait when the keeping is full, else null.
 */
export async function readFullKeeping(port: EnginePort): Promise<number | null> {
  const state = await readProcessState(port)
  const count = state ? readKeptStarts(state).length : 0
  return count < keptStartLimit ? null : count
}

/**
 * Changes the process state as the load it records, the one way every claim, settlement and release does: the step runs inside the
 * compare-and-set on the current state, after the check that the caller's load is the one the state records, or the one that replaces
 * the load it names, which records itself in the same write; and either wins, naming the state it writes, or is refused, writing
 * nothing. The caller acts only on a win.
 * @param port - The engine calls.
 * @param loadId - The caller's load, or null for a change any load may make, as recording a receipt or a load.
 * @param step - Decides on the current state; it may run more than once.
 * @returns Won with its value and the state written; refused with why; or unknown when the state could not be read or written.
 */
export async function transitOwned<T>(port: EnginePort, loadId: string | null, step: (state: ProcessState) => OwnedStep<T>): Promise<OwnedTransition<T>> {
  const predecessor = loadId !== null && loadId === load.id ? load.predecessor : undefined
  // why: only a refusal decided after this load's record landed shows it replaced; one decided before it, answered after, shows nothing.
  const wasRecorded = loadId !== null && loadId === load.id && load.isRecorded
  try {
    return await transactProcess<OwnedTransition<T>>(port, held => {
      const claimed = loadId === null || held.loadId === loadId ? held : predecessor === undefined ? null : claimLoad(held, loadId, predecessor)
      const decided = claimed ? step(claimed) : { kind: 'not-owner' as const }
      return decided.kind === 'won' ? { state: decided.state, result: { kind: 'won', value: decided.value, state: decided.state } } : { state: held, result: { kind: decided.kind } }
    }).then(outcome => {
      if (outcome.kind === 'won' && loadId !== null && outcome.state.loadId === loadId) noteLoadRecorded(loadId)
      // why: a load recorded before its write that the write finds replaced was superseded for good, as only a newer load replaces it, or one whose first look came late; it says so on its pane.
      if (outcome.kind === 'not-owner' && wasRecorded && loadId === load.id) sessionMemory.isLoadSuperseded = true
      return outcome
    })
  } catch (error) {
    return { kind: 'unknown', error: formatError(error) }
  }
}

/**
 * Changes the process state with a compare-and-set whose step is pure: it maps the current state to the state it writes and a typed
 * result, may run more than once on stale and current values, and only the result of the run that was written is returned, so a
 * caller's memory effects follow the winning write alone.
 * @param port - The engine calls.
 * @param step - Decides on the current state, with no effect of its own.
 * @returns The written run's result.
 * @throws When the host holds a value this module does not know, or the write fails.
 */
export async function transactProcess<R>(port: EnginePort, step: (held: ProcessState) => Transaction<R>): Promise<R> {
  const runs: Transaction<R>[] = []
  await updateProcessState(port, held => {
    const run = step(held)
    runs.push(run)
    return run.state
  })
  // why: the host writes the state the last run returned, so that run's result is the one that took effect.
  const last = runs.at(-1)
  if (!last) throw new Error('the compare-and-set ran no step')
  return last.result
}

/**
 * Records this load as the one the process state names, only while it names none, this load, or the load it named when this load first
 * looked, which this load replaces. A load recorded since then may be newer, as load ids carry no order, so this one stands down for
 * good: supersession is never undone, by time or otherwise, so a replaced load that resumes can never take the state back.
 * @param state - The process state the record writes over.
 * @param loadId - This load.
 * @param predecessor - The load the state named when this load first looked, null for none.
 * @returns The state recording this load, or null when it stands down.
 */
export function claimLoad(state: ProcessState, loadId: string, predecessor: string | null): ProcessState | null {
  if (state.loadId === loadId) return state
  // why: the heartbeat an earlier version wrote is dropped, as the host keeps JSON, which leaves an undefined field out.
  return state.loadId === undefined || state.loadId === predecessor ? { ...state, loadId, loadBeat: undefined } : null
}
