import type { Next } from 'claude-code'

import type { Attempt, KeptStart, Notice, ProcessState } from '../../types'
import { followApproval } from '../../hooks/core/approval-wake'
import { digestPrompt, shortId, submitAttempt } from '../../hooks/core/attempts'
import { DroppedPromptError } from '../../hooks/core/engine-port'
import type { EnginePort } from '../../hooks/core/engine-port'
import { bindSend, markSent } from '../../hooks/core/mail-send'
import { refreshView } from '../../hooks/core/pane-view'
import { decodeProcessState, readKeptStarts, readLoadId } from '../../hooks/core/process-state'
import { tickMs } from '../../hooks/core/timing'
import { stampHost } from '../../hooks/core/host'
import { submitStart } from '../../hooks/core/user-steps'
import { doorbellText } from '../../hooks/domain/mail'
import type { Position } from '../../hooks/domain/step-states'
import { handleMailPromptSubmit } from '../../hooks/handlers/mail'
import { handleClassicSessionStart, handleSessionStart } from '../../hooks/handlers/session'
import { handleToolCall } from '../../hooks/handlers/tool-call'
import { handleTurnComplete, handleTurnStart } from '../../hooks/handlers/turn'
import { handleStop } from '../../hooks/handlers/worktree'
import { handlePaneRender } from '../../hooks/handlers/pane-render'
import type { PaneElements } from '../../hooks/ui/pane-sections'
import { createMomentPort, createScheduler } from './loads'
import type { FaultRecord, Load, Moment, OpClass, RuleMode, Scheduler } from './loads'
import { diagnoseRuns, diagnosisComment } from './builders'
import { buildStat, createTestPort, createWorld, records, root, seedDelegation } from './world'
import type { World } from './world'
import { soakPerSeed } from './soak'

/** A step that sets a rule on the engine's calls: a mode on the next call of a class, or a fault on every call of it until lifted. */
type RuleStep = `${RuleMode}:${OpClass}` | `on:${OpClass}` | `off:${OpClass}`

/**
 * One event of a schedule. Each runs the mod's real handlers and drivers, never a model of them, as a dispatch of the load the engine
 * sends it to, without waiting for it to end: an event whose call the schedule suspended stays in flight while later events run, and
 * resumes, as its own load, when the schedule resumes that call. `turn` is a typed prompt entering and its turn starting, which `type` and
 * `begin` split. `open` and `close` open and close the Flow pane, `runlog` and `flow` select its view, and `render` draws it as the host
 * does while it is open, through a window showing all of it, only its first rows, or rows scrolled past its top; `foreign` leaves a process
 * state of a shape this version does not know; `cut` drops the oldest suspended call of a load a reload replaced, which never resumes,
 * as the host may cut a replaced module's work; `drop-prompt` ends an entering prompt that starts no turn, as one the user withdrew or a
 * hook blocked after this mod's hook. The older names stand for rules: `write-once` fails the next state write,
 * `write-on`/`-off` every one, `read-`, `activity-`, `host-` and `own-` the same for state reads, the activity record, the host record and
 * this process's identity; `stall` holds the next state write and `release` resumes it. `fresh` makes every later dispatch read the
 * process state afresh at each read, as an engine that kept no dispatch moment would.
 */
export type Step =
  | 'keep' | 'step' | 'turn' | 'type' | 'begin' | 'end' | 'interrupt' | 'overlap' | 'turn-failed' | 'end-failed' | 'overlap-failed' | 'upgrade'
  | 'stop' | 'compact' | 'tool' | 'send' | 'sent' | 'wake' | 'doorbell' | 'conclude' | 'migrate'
  | 'ok' | 'drop' | 'fail' | 'time' | 'tick' | 'paint' | 'reload' | 'restart' | 'resume' | 'resume-new' | RuleStep
  | 'write-once' | 'write-on' | 'write-off' | 'read-on' | 'read-off' | 'activity-on' | 'activity-off' | 'host-on' | 'host-off' | 'own-on' | 'own-off'
  | 'stall' | 'release' | 'fresh' | 'rogue' | 'open' | 'close' | 'runlog' | 'flow' | 'render' | 'render-short' | 'render-scrolled' | 'foreign' | 'cut' | 'drop-prompt'

/** An invariant a schedule broke: which, at which step, and what was seen. */
export interface Violation { invariant: 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7'; step: number; detail: string }

/** A submit the engine received: its text and route, the load that made it and when, how the schedule answered it, and the attempt that claimed it. */
interface Submit {
  text: string; route: 'start' | 'wake' | 'doorbell'; load: Load; at: number; step: number; status: 'pending' | 'ok' | 'drop' | 'fail' | 'dead'; attempt: Attempt | null
  /** When, in the run's order, the schedule answered it. */
  answeredAt?: number
  /** Whether the load that made it never heard its answer; and whether its prompt was since seen entering, which is evidence of that answer. */
  isLost?: boolean; isSeen?: boolean
  resolve: () => void; reject: (error: unknown) => void
}

/** A send in flight: the turn running when it began, and the turn the mod bound it to, once its binding answered. */
interface Send { bound: string | null; turnId?: string | null }

/** A start whose keep landed, in the order it landed: its token, its kind, its process and its id in the keeping. */
interface Kept { seq: number; token: string; kind: 'coordinate' | 'step'; process: number; id: string | null; at: number }

/**
 * An event after which the mod may release an ambiguous obligation: the user's typed prompt entering, or a reload; when, in the run's
 * order; and the submits it releases, judged as it happens: one that failed, or one still unanswered a tick after it was made.
 */
interface Release { kind: 'typed' | 'reload'; at: number; step: number; released: Set<Submit> }

/** What really happened, as the engine and the user would know it, which the mod's records and words are judged against. */
interface Truth {
  turn: string | null; turns: number; process: number; pid: number
  /** The turns that sent a message, and the sends still in flight, each bound to the turn running when it began. */
  sent: Set<string>; sends: Send[]
  kept: Kept[]; seq: number; submits: Submit[]; releases: Release[]; entered: Map<string, number>
  /** The step at which the unit concluded, after which a step start has nothing to start; and the approved configs whose wake is owed. */
  concludedAt: number | null; wakes: { blob: string; process: number }[]; migrated: { id: string; process: number }[]
  /** The loads a reload started, and those of them that heard a turn start, a turn end or a prompt enter since. */
  reloaded: Set<Load>; heardBoundary: Set<Load>
  /** The load that heard the prompt entering now, and the load that heard a prompt enter that then started no turn, until it hears another boundary. */
  enteringBy: Load | null; stranded: Load | null
}

/** What completed renders of the Flow view drew: the last one's text and when, in the run's order; and every notice any of them showed, by id and by revision, with whether the last that showed it called its outcome unknown. */
interface Rendered { text: string; order: number; ids: Set<string>; causes: Map<string, { said: Said; order: number }> }

/** What a drawn notice said of its obligation's outcome. */
type Said = 'unknown' | 'entered' | 'dropped' | 'unstarted'

/** A defect a mutation check injects at the hooks' boundary, each the target of one invariant. */
export type Mutation = 'turn-unwritten' | 'unknown-retried' | 'order-reversed' | 'notices-dropped' | 'hold-row-hidden' | 'old-load-unfenced' | 'delivery-dropped'
  | 'receipt-lost' | 'false-explanation' | 'offscreen-ack' | 'view-unfenced'

/** One run of a schedule. */
interface Run {
  world: World; scheduler: Scheduler; truth: Truth; violations: Violation[]; step: number; ports: Map<Load, EnginePort>; ids: Map<string, Load>
  /** What the last completed render of the Flow view drew; and whether the pane is open, and which view it shows. */
  rendered: Rendered; pane: { isOpen: boolean }
  writesSeen: number
  /** Orders submits, releases and renders as they happened, across the schedule and the rest after it. */
  order: number
  /** The order each start's keep landed in, by token; and, for each claim, whether the session was idle when it landed. */
  keptOrder: Map<string, { order: number; process: number }>; claimedIdle: Map<string, boolean>
  /** Whether dispatches read the process state afresh at each read. */
  isFresh: boolean
  /** The obligations each overflow notice covers, by its id and label. */
  covers: Map<string, Set<string>>
  /** Each session record the store held, by its text, with the version it stood at; and the newest version the mirror was written from. */
  sessions: Map<string, number>; mirrored: { version: number; revision: { generation: string; version: number } | null }
  /** A render that promised the mod records no turn change for the coordinator, and the activity record it saw then. */
  promise: { activity: string | undefined } | null
  mutation: Mutation | null
  /** The loads whose suspended claim of a load number landed after a newer load started, so the number may outrank that load's. */
  lateClaims: Set<Load>; isLateClaimExcused: boolean
  /** The loads whose registration of the mod's tools failed, which hold every prompt of the mod until a start registers them. */
  unregistered: Set<Load>
  /** When, in the run's order, each load's last process-state read answered, which the view it paints next observed. */
  lastRead: Map<Load, number>
  /** The view the pane holds: the load that published it and when its observation was read; null before any. */
  view: { load: Load; observedAt: number } | null
  /** Each turn change in the run's order, so a view is judged against the turn at its observation. */
  turnHistory: { order: number; turn: string | null }[]
  /** The attempts the recorded load settled as established, and when each attempt became unknown, in the run's order. */
  settled: Set<string>; unknownAt: Map<string, number>
  /** Whether the pane was closed by the schedule's last pane event, so it stays closed at rest. */
  isPaneClosed: boolean
  /** Every attempt any write held, by id, as first written. */
  attemptsSeen: Map<string, Attempt>
  /** The prompts the engine accepted while a turn ran, which enter in order as turns end. */
  queued: string[]
}

/** What the exploration counted across every schedule run: the submits that entered the host's claim-to-submit interval, which no submit-if-idle closes, and the schedules run. */
export const explorerStats: { exposure: number; schedules: number; followUps: number; lastFaults: FaultRecord } = { exposure: 0, schedules: 0, followUps: 0, lastFaults: { faults: 0, isSuspendedAcrossLoad: false } }

/** The events the bounded exhaustive exploration enumerates: the turn and start events, each with the write that fails under it, the answers, time, reload, a held write and its resume. */
export const exhaustiveAlphabet: readonly Step[] = ['keep', 'turn', 'turn-failed', 'end', 'end-failed', 'overlap', 'overlap-failed', 'ok', 'drop', 'time', 'tick', 'reload', 'stall', 'release']

/** How many random schedules each seed draws in the normal suite; a soak run draws more. */
const randomCount = 25

/** How many random schedules one test runs, so each test stays within its time bound. */
const chunkSize = 5

/** How many events each random schedule has. */
const randomLength = 24

/** The id every overflow notice's id starts with. */
const overflowPrefix = 'notice:overflow'

/** When the explorer's sessions start, in epoch ms. */
const sessionStartMs = Date.UTC(2026, 0, 1)

/** The classes a rule names in the seeded random exploration, with the modes each takes. */
const ruleClasses: readonly OpClass[] = ['state-read', 'state-write', 'session-read', 'session-write', 'activity', 'host', 'identity', 'records', 'lock', 'paint', 'registration', 'submit', 'clock', 'seq']

/** Every event, which the seeded random exploration draws from: the rules over every class, each mode, among them. */
const fullAlphabet: readonly Step[] = [...exhaustiveAlphabet, 'step', 'interrupt', 'stop', 'compact', 'tool', 'send', 'sent', 'wake', 'doorbell', 'conclude', 'migrate', 'cut',
  'fail', 'paint', 'paint', 'restart', 'upgrade', 'resume', 'resume-new', 'tick', 'keep', 'turn', 'end', 'type', 'begin', 'open', 'close', 'runlog', 'flow', 'render', 'render', 'foreign',
  'render-short', 'render-scrolled', 'drop-prompt',
  ...ruleClasses.flatMap(cls => (['hold', 'park', 'fail', 'lose'] as const).map(mode => `${mode}:${cls}` as RuleStep)), 'park:rename', 'lose:rename',
  'on:state-write', 'off:state-write', 'on:state-read', 'off:state-read', 'on:activity', 'off:activity', 'on:host', 'off:host', 'on:identity', 'off:identity']

/** The older names of rules. */
const aliases: Partial<Record<Step, RuleStep | 'resume'>> = {
  'write-once': 'fail:state-write', 'write-on': 'on:state-write', 'write-off': 'off:state-write', 'read-on': 'on:state-read', 'read-off': 'off:state-read',
  'activity-on': 'on:activity', 'activity-off': 'off:activity', 'host-on': 'on:host', 'host-off': 'off:host', 'own-on': 'on:identity', 'own-off': 'off:identity',
  stall: 'hold:state-write', release: 'resume',
}

/** An element table that builds the pane's tree without drawing it, as a render's text is judged from the view it read. */
const paneElements = { Box: () => null, Text: () => null, Button: () => null } as unknown as PaneElements

/**
 * Reads both keys a dispatch moment holds, as the host holds them now.
 * @param world - The world.
 * @returns The process state and the session store's value.
 */
const snapshotState = (world: World): Moment =>
  ({ process: world.processState.value, session: world.peekSessionState() })

/**
 * Builds a dispatch's port that reads one moment, and judges a view it publishes against that moment: the one its observation read.
 * @param run - The run.
 * @param load - The load.
 * @param base - The load's port.
 * @returns The port, and how to start its moment over.
 */
function observeMoment(run: Run, load: Load, base: EnginePort): { port: EnginePort; reset: () => void } {
  const observed = { at: 0 }
  // why: a missed write moves the moment on to the host's value then, which a view the dispatch publishes after it observed instead.
  // why: the moment is the one its own read landed at, never a later read of another dispatch of the same load.
  const moment = createMomentPort(base, () => readMoment(run, load, at => { observed.at = at }), () => {
    observed.at = run.order
    return snapshotState(run.world)
  })
  return { reset: moment.reset, port: { ...moment.port, writeView: async (view, seq) => {
    const isPublished = await moment.port.writeView(view, seq)
    if (isPublished && run.view?.load === load) run.view = { load, observedAt: observed.at }
    return isPublished
  } } }
}

/**
 * Reads a dispatch's moment as one call of its load: both keys as they stand when the call lands, which is also when the view the
 * dispatch may paint observed them.
 * @param run - The run.
 * @param load - The load.
 * @param onLanded - Hears the run's order as the call lands.
 * @returns The moment.
 */
const readMoment = (run: Run, load: Load, onLanded: (at: number) => void = () => {}): Promise<Moment> => run.scheduler.op(load, 'state-read', 'moment read', async () => {
  run.order += 1
  run.lastRead.set(load, run.order)
  onLanded(run.order)
  return snapshotState(run.world)
}).then(moment => {
  // why: a load's first look is the first read whose answer it receives, which a suspended answer delays.
  if (!run.scheduler.firstReads.has(load)) run.scheduler.firstReads.set(load, moment.process)
  return moment
})

/**
 * Reads the process state as the mod decodes it.
 * @param world - The world.
 * @returns The state, or null when absent or unknown.
 */
function readState(world: World): ProcessState | null {
  return world.processState.value === undefined ? null : decodeProcessState(world.processState.value)
}

/**
 * Notes a violation.
 * @param run - The run.
 * @param invariant - Which.
 * @param detail - What was seen.
 */
function violate(run: Run, invariant: Violation['invariant'], detail: string): void {
  run.violations.push({ invariant, step: run.step, detail })
}

/**
 * Tells whether a submit is still ambiguous now: unanswered or failed, in the live process, and not released by an event the mod may take
 * as resolving it: the user's typed prompt or a reload, which releases a failed submit at once, and an unanswered one a tick after it.
 * @param run - The run.
 * @param submit - The submit.
 * @param now - The time.
 * @returns Whether it is.
 */
function isAmbiguous(run: Run, submit: Submit, now: number): boolean {
  if (submit.load.process !== run.truth.process || submit.status !== 'pending' && submit.status !== 'fail') return false
  // why: a submit still unanswered within its tick may still be entering, whatever happened since; past it, a release at any time after covers it, as the mod releases it at its next tick.
  const isAged = now - submit.at >= tickMs
  return now - submit.at < tickMs && submit.status === 'pending' || !run.truth.releases.some(release => release.released.has(submit) || release.step > submit.step && release.kind === 'reload' && isAged && submit.load.n < run.scheduler.loads.length)
}

/**
 * Notes an event the mod may take as releasing what is ambiguous now.
 * @param run - The run.
 * @param kind - Which event.
 */
function noteRelease(run: Run, kind: Release['kind']): void {
  const now = run.world.clock.now()
  run.order += 1
  const released = new Set(run.truth.submits.filter(submit => submit.load.process === run.truth.process && (submit.status === 'fail' || submit.status === 'pending' && now - submit.at >= tickMs)))
  run.truth.releases.push({ kind, at: now, step: run.order, released })
}

/**
 * Receives a submit the mod made, checks what must hold at that moment, and leaves it pending for the schedule to answer. A submit into a
 * busy session whose claim landed while the session was idle went through the host's claim-to-submit interval, which no submit-if-idle
 * closes: it is counted as that exposure, never passed as idle.
 * @param run - The run.
 * @param load - The load whose port submitted it.
 * @param text - The prompt.
 * @returns The submit's answer, once the schedule gives it.
 */
function receiveSubmit(run: Run, load: Load, text: string): Promise<void> {
  const { truth } = run
  const route = text === doorbellText ? 'doorbell' : /(start|step)#\d+#/.test(text) ? 'start' : 'wake'
  const state = readState(run.world)
  const claimed = findClaim(run, load, text)
  const now = run.world.clock.now()
  if (truth.turn !== null) {
    if (claimed && run.claimedIdle.get(claimed.id) === true) explorerStats.exposure += 1
    else violate(run, 'I1', `${route} submitted while turn ${truth.turn} runs`)
  }
  const ambiguous = truth.submits.filter(each => isAmbiguous(run, each, now))
  if (ambiguous.length) violate(run, 'I1', `${route} submitted while an earlier ${ambiguous.map(each => each.route).join(', ')} submit may still enter`)
  if (!claimed) violate(run, 'I6', `${route} submitted with no attempt written before it`)
  else if (run.ids.get(claimed.owner) !== load) violate(run, 'I6', `${route} submitted by load ${load.n} under another load's attempt`)
  const token = /(?:start|step)#\d+#/.exec(text)?.[0]
  const subject = route === 'wake' ? claimed?.subject : token ?? route
  const earlier = truth.submits.filter(each => (route === 'wake' ? each.attempt?.subject === subject : token ? each.text.includes(token) : false) && each.load.process === load.process)
  if (earlier.some(each => each.status === 'pending' || each.status === 'fail' || each.status === 'ok')) violate(run, 'I2', `a ${route} that may have entered was submitted again`)
  const place = token ? run.keptOrder.get(token) : undefined
  if (route === 'start' && token && place) {
    const earlierTokens = [...run.keptOrder].filter(([, each]) => each.order < place.order && each.process === place.process).map(([each]) => each)
    const waiting = earlierTokens.filter(each => isWaiting(run, { seq: 0, token: each, kind: each.startsWith('step') ? 'step' : 'coordinate', process: load.process, id: null, at: 0 }))
    if (waiting.length) violate(run, 'I3', `${token} submitted before ${waiting.join(', ')}, kept before it, entered`)
  }
  const shownCompose = /\[([0-9a-f-]{8})\] could not be composed/.exec(run.rendered.text)?.[1]
  if (route !== 'start' && shownCompose && state && readKeptStarts(state)[0]?.id.startsWith(shownCompose) && run.rendered.text.includes('submits no start, wake or doorbell')) {
    violate(run, 'I5', `a ${route} was submitted while the pane promised none until the start first in line composes`)
  }
  run.order += 1
  const order = run.order
  return new Promise<void>((resolve, reject) => {
    truth.submits.push({ text, route, load, at: now, step: order, status: 'pending', attempt: claimed, resolve, reject })
  })
}

/**
 * Finds the attempt a submit carries out: the latest claim of its prompt not yet matched to a submit, this load's first.
 * @param run - The run.
 * @param load - The load that submits.
 * @param text - The prompt.
 * @returns The attempt, or null when none was written.
 */
function findClaim(run: Run, load: Load, text: string): Submit['attempt'] {
  const known = new Set(run.truth.submits.map(each => each.attempt?.id))
  // why: an attempt names the prompt it submits by its digest, so the submit is matched to its own claim even when two claims overlap; a submit the schedule held may reach the host after its claim turned unknown or ended, so every claim this load wrote counts.
  return [...run.attemptsSeen.values()].filter(attempt => !known.has(attempt.id) && attempt.digest === digestPrompt(text) && run.ids.get(attempt.owner) === load).at(-1)
    ?? [...run.attemptsSeen.values()].filter(attempt => !known.has(attempt.id) && attempt.digest === digestPrompt(text)).at(-1) ?? null
}

/**
 * Notes a submit that failed before it reached the host: it never entered, and the load that made it cannot tell it from a submit that
 * may have, so it stands as a failed submit, which an event the mod may take as releasing it covers.
 * @param run - The run.
 * @param load - The load that submitted.
 * @param text - The prompt.
 */
function noteUnsent(run: Run, load: Load, text: string): void {
  const route = text === doorbellText ? 'doorbell' : /(start|step)#\d+#/.test(text) ? 'start' : 'wake'
  run.order += 1
  run.truth.submits.push({ text, route, load, at: run.world.clock.now(), step: run.order, status: 'fail', attempt: findClaim(run, load, text), resolve: () => {}, reject: () => {} })
}

/**
 * Notes that a load never heard the answer to its submit: until the prompt is seen entering, the load has no evidence of that answer.
 * @param run - The run.
 * @param load - The load that submitted.
 * @param text - The prompt.
 */
function noteLost(run: Run, load: Load, text: string): void {
  const submit = run.truth.submits.findLast(each => each.load === load && each.text === text)
  if (submit) submit.isLost = true
}

/**
 * Tells whether a kept start still waits to enter: not entered, not released by an event the mod may take as resolving its ambiguous
 * submit, and not one with nothing to start once the unit concluded.
 * @param run - The run.
 * @param kept - The start.
 * @returns Whether it does.
 */
function isWaiting(run: Run, kept: Kept): boolean {
  if (isEntered(run.truth, kept.token)) return false
  if (kept.kind === 'step' && run.truth.concludedAt !== null) return false
  return !isReleasable(run, kept.token)
}

/**
 * Tells whether an obligation's submit was ambiguous at an event the mod may take as releasing it.
 * @param run - The run.
 * @param token - The obligation's token or wake subject.
 * @returns Whether it was.
 */
function isReleasable(run: Run, token: string): boolean {
  return run.truth.submits.some(submit => (submit.text.includes(token) || submit.attempt?.subject === token) && submit.load.process === run.truth.process
    && (submit.status === 'pending' || submit.status === 'fail') && !isAmbiguous(run, submit, run.world.clock.now()))
}

/**
 * Tells whether a prompt carrying a token entered.
 * @param truth - What really happened.
 * @param token - The token.
 * @returns Whether it entered.
 */
const isEntered = (truth: Truth, token: string): boolean => [...truth.entered.keys()].some(text => text.includes(token))

/**
 * Runs work as a dispatch of the current load, with a port of its own that reads one moment.
 * @param run - The run.
 * @param work - The handler.
 * @returns The dispatch's outcome, once dispatched and settled as far as it can.
 */
async function dispatch<T>(run: Run, work: (port: EnginePort) => Promise<T>): Promise<{ done: Promise<T | undefined> }> {
  const load = run.scheduler.current()
  const base = load ? run.ports.get(load) : undefined
  if (!load || !base) return { done: Promise.resolve(undefined) }
  return run.scheduler.run(load, () => work(run.isFresh ? base : observeMoment(run, load, base).port))
}

/**
 * Dispatches a turn start as the engine does after a prompt entered.
 * @param run - The run.
 * @returns Once dispatched.
 */
async function startTurn(run: Run): Promise<void> {
  run.truth.turns += 1
  const turnId = `t${run.truth.turns}`
  run.truth.turn = turnId
  noteBoundary(run)
  await dispatch(run, port => handleTurnStart(port, { text: 'go', turnId } as never, (async () => ({ turnId })) as unknown as Next<'turn.start'>))
  checkPromise(run)
}

/**
 * Notes that the current load heard a turn start, a turn end or a prompt entering, after which a reload's uncertainty no longer holds it.
 * @param run - The run.
 */
function noteBoundary(run: Run): void {
  const load = run.scheduler.current()
  if (load) run.truth.heardBoundary.add(load)
  run.truth.stranded = null
}

/**
 * Checks a render's promise that the mod records no turn change for the coordinator against the activity record a turn change left.
 * @param run - The run.
 */
function checkPromise(run: Run): void {
  if (run.promise && run.world.files.get(`${records}/activity/sid.json`) !== run.promise.activity) {
    violate(run, 'I5', 'the pane said no turn change is recorded for the coordinator, and one was')
    run.promise = null
  }
}

/**
 * Dispatches a turn's end.
 * @param run - The run.
 * @param turnId - The turn.
 * @param isAborted - Whether it was interrupted.
 * @returns Once dispatched.
 */
async function endTurn(run: Run, turnId: string, isAborted: boolean): Promise<void> {
  noteBoundary(run)
  await dispatch(run, port => handleTurnComplete(port, { reason: isAborted ? 'aborted' : 'answer', answer: '', durationMs: 0, isAborted, turnId } as never,
    (async () => ({ text: '' })) as unknown as Next<'turn.complete'>))
  checkPromise(run)
  const queued = run.queued.shift()
  if (queued !== undefined && run.truth.turn === null) await enter(run, queued, false)
}

/**
 * Enters a prompt and starts its turn, as the engine does with a prompt it accepted; a typed prompt is an event the mod may take as the
 * user taking over.
 * @param run - The run.
 * @param text - The prompt.
 * @param isTyped - Whether the user typed it.
 * @returns Once both are dispatched.
 */
async function enter(run: Run, text: string, isTyped: boolean): Promise<void> {
  await enterPrompt(run, text, isTyped)
  await startTurn(run)
}

/**
 * Enters a prompt, as the engine does before the turn it starts.
 * @param run - The run.
 * @param text - The prompt.
 * @param isTyped - Whether the user typed it.
 * @returns Once dispatched.
 */
async function enterPrompt(run: Run, text: string, isTyped: boolean): Promise<void> {
  run.truth.turn = 'entering'
  noteBoundary(run)
  run.truth.enteringBy = run.scheduler.current()
  const unseen = run.truth.submits.find(each => each.text === text && each.status === 'ok' && !each.isSeen)
  if (unseen) unseen.isSeen = true
  if (isTyped) noteRelease(run, 'typed')
  await dispatch(run, port => handleMailPromptSubmit(port, { prompt: text, permission_mode: 'default' } as never, (async () => ({})) as unknown as Next<'classic.UserPromptSubmit'>))
}

/**
 * Answers the oldest submit still pending in the live process, whichever load made it; the load receives the answer as its own.
 * @param run - The run.
 * @param outcome - How the engine answers.
 * @returns Once the answer, and the turn an accepted prompt starts, are dispatched.
 */
async function answer(run: Run, outcome: 'ok' | 'drop' | 'fail'): Promise<void> {
  const submit = run.truth.submits.find(each => each.status === 'pending' && each.load.process === run.truth.process)
  if (!submit) return
  submit.status = outcome
  run.order += 1
  submit.answeredAt = run.order
  if (outcome === 'drop') submit.reject(new DroppedPromptError('a Stop stands'))
  else if (outcome === 'fail') submit.reject(new Error('the engine failed the submit'))
  else {
    const entries = (run.truth.entered.get(submit.text) ?? 0) + 1
    run.truth.entered.set(submit.text, entries)
    if (submit.route === 'start' && entries > 1) violate(run, 'I2', `${submit.text.slice(0, 40)} entered ${entries} times`)
    submit.resolve()
  }
  await run.scheduler.pump()
  // why: a prompt the engine accepted while a turn runs waits in its queue and enters once that turn ends.
  if (outcome === 'ok' && run.truth.turn === null) await enter(run, submit.text, false)
  else if (outcome === 'ok') run.queued.push(submit.text)
}

/**
 * Starts a load of the mod as a session start does: a reload in this process, a new process, or an upgrade from an earlier version that
 * kept no process state. A reload cancels the replaced load's tick, deferred work and waits; its dispatches in flight go on.
 * @param run - The run.
 * @param start - Which of these.
 * @param arrange - Sets the records the earlier version left, before the start.
 * @returns Once the start is dispatched.
 */
async function startModule(run: Run, start: 'reload' | 'process' | 'upgrade', arrange: () => void = () => {}): Promise<void> {
  const { truth, scheduler, world } = run
  const replaced = scheduler.current()
  if (start === 'reload' && replaced) {
    await scheduler.cancel(replaced)
    noteRelease(run, 'reload')
  }
  if (start !== 'reload') {
    // why: a new process, or one an earlier version of the mod ran in, holds none of this version's process state: its kept starts and its submits in flight are gone with it.
    scheduler.end(truth.process)
    truth.process += 1
    truth.turn = null
    for (const submit of truth.submits) if (submit.status === 'pending') submit.status = 'dead'
    run.queued.length = 0
    world.processState.value = undefined
    if (start === 'process') truth.pid += 1
    world.files.set('/proc/self/stat', buildStat(truth.pid, String(truth.pid * 10)))
  }
  arrange()
  const load = scheduler.spawn(truth.process)
  if (start === 'reload') truth.reloaded.add(load)
  run.ids.set(readLoadId(), load)
  const host = mutate(run, load, createTestPort(world))
  // why: a view is current from the moment its write lands at the host, however late the paint's continuation resumes, so a publication is noted and judged there.
  const landing: EnginePort = { ...host, claimLoadSeq: async () => {
    const seq = await host.claimLoadSeq()
    if (run.scheduler.suspendedClaims.has(load) && run.scheduler.loads.some(other => other.n > load.n)) run.lateClaims.add(load)
    return seq
  }, writeView: async (view, seq) => {
    const isPublished = await host.writeView(view, seq)
    if (!isPublished) return false
    // why: a load the state records holds the authority, the documented late first look included, so its view stands even over a newer load's that stood down.
    const recorded = readState(run.world)?.loadId
    // why: a load whose first look named a load started after it took that one for the one it replaces, the documented late first look, and holds the authority from there.
    const firstLook = run.scheduler.firstReads.get(load)
    const isLateLook = !!firstLook && (run.ids.get(decodeProcessState(firstLook)?.loadId ?? '')?.n ?? 0) > load.n
    // why: a load whose held or parked number claim landed after a newer load started may outrank it, a presentation limit the user recovers from with another reload; it excuses that load's views alone, never a submission, claim, queue or receipt.
    const isLateClaim = run.isLateClaimExcused && run.lateClaims.has(load)
    if (run.view && run.view.load.n > load.n && !run.view.load.isGone && run.ids.get(recorded ?? '') !== load && !isLateLook && !isLateClaim) violate(run, 'I6', `load ${load.n} published a view over load ${run.view.load.n}'s, which a reload started after it`)
    run.view = { load, observedAt: run.lastRead.get(load) ?? 0 }
    return true
  } }
  const wrapped = scheduler.wrap(load, landing, (each, text) => receiveSubmit(run, each, text), (each, text, how) => { if (how === 'unsent') noteUnsent(run, each, text); else noteLost(run, each, text) })
  // why: deferred work is the scheduler's own, so the defect that drops it is injected over the scheduler's port.
  // why: a view is judged against the moment its observation read, so each load's last process-state read is noted as it answers.
  const tracked: EnginePort = { ...wrapped, registerSurface: () => wrapped.registerSurface().catch((error: unknown) => { run.unregistered.add(load); throw error }),
    readProcessState: async () => {
      const value = await wrapped.readProcessState()
      run.order += 1
      run.lastRead.set(load, run.order)
      return value
    },
  }
  const base: EnginePort = run.mutation === 'delivery-dropped' ? { ...tracked, defer: () => {} } : tracked
  run.ports.set(load, base)
  const moment = observeMoment(run, load, base)
  load.resetMoment = moment.reset
  await scheduler.run(load, () => handleSessionStart(moment.port, { cwd: root, surface: null, isInteractive: false },
    (async (event: { cwd: string }) => ({ cwd: event.cwd })) as unknown as Next<'session.start'>))
}

/**
 * Injects a mutation check's defect at the boundary of a load's hooks, as the engine calls they make: each corrupts what the hooks read
 * or write the way a defect of that kind in them would, so the invariant aimed at it must go red.
 * @param run - The run.
 * @param load - The load.
 * @param port - The load's engine calls.
 * @returns The calls, with the defect injected.
 */
function mutate(run: Run, load: Load, port: EnginePort): EnginePort {
  const mutation = run.mutation
  const decode = (value: unknown): ProcessState | null => value === undefined ? null : decodeProcessState(value)
  const rewrite = (change: (value: unknown) => unknown): EnginePort['updateProcessState'] => step => port.updateProcessState(current => {
    const written = step(current as never) as unknown
    return change(written) as never
  })
  if (mutation === 'turn-unwritten') {
    // why: a turn start that writes no turn, as a start handler that lost its write would.
    return { ...port, updateProcessState: step => port.updateProcessState(current => {
      const written = step(current as never) as unknown as ProcessState
      const before = decode(current)
      return (written.turn && written.turn.id !== before?.turn?.id ? { ...written, turn: before?.turn ?? null } : written) as never
    }) }
  }
  if (mutation === 'unknown-retried') {
    // why: an unknown outcome taken for a drop, as a receipt that misreads an unanswered submit would, so the start is submitted again.
    return { ...port, updateProcessState: rewrite(value => {
      const state = value as ProcessState
      return { ...state, attempts: (state.attempts ?? []).map(attempt => attempt.status.kind === 'unknown' ? { ...attempt, status: { kind: 'dropped', cause: 'misread' } } : attempt) }
    }) }
  }
  if (mutation === 'order-reversed') {
    // why: a start kept ahead of those kept before it, as a keeping that puts the newest first would.
    return { ...port, updateProcessState: step => port.updateProcessState(current => {
      const written = step(current as never) as unknown as Record<string, unknown>
      const earlier = (current as { pendingStarts?: unknown[] } | undefined)?.pendingStarts ?? []
      const starts = Array.isArray(written.pendingStarts) ? written.pendingStarts as unknown[] : []
      return (starts.length > earlier.length ? { ...written, pendingStarts: [...starts.slice(earlier.length), ...starts.slice(0, earlier.length)] } : written) as never
    }) }
  }
  if (mutation === 'notices-dropped') return { ...port, updateProcessState: rewrite(value => ({ ...value as ProcessState, notices: [] })) }
  if (mutation === 'hold-row-hidden') {
    return { ...port, writeView: (view, seq) => port.writeView(view && { ...view, notes: view.notes.filter(note => note.key !== 'Process') }, seq) }
  }
  if (mutation === 'receipt-lost') {
    // why: an established answer that reaches no record once its attempt is gone, as a receipt kept only on its attempt would.
    return { ...port, updateProcessState: step => port.updateProcessState(current => {
      const written = step(current as never) as unknown as ProcessState
      const before = decode(current)
      return (before ? { ...written, receipts: before.receipts, notices: (written.notices ?? []).map(notice => ({ ...notice, outcome: before.notices?.find(each => each.id === notice.id)?.outcome })) } : written) as never
    }) }
  }
  if (mutation === 'false-explanation') {
    // why: a notice drawn as entered whatever it holds, as wording that read the wrong field would.
    return { ...port, writeView: (view, seq) => port.writeView(view && { ...view, notes: view.notes.map(note => ({ ...note, value: note.value.replace('whether it entered is unknown', 'it entered, after the mod had stopped waiting for its answer') })) }, seq) }
  }
  if (mutation === 'view-unfenced') {
    // why: a view published whatever load number stands, as a publication with no fence would.
    return { ...port, writeView: view => port.writeView(view, Number.MAX_SAFE_INTEGER) }
  }
  if (mutation === 'old-load-unfenced') {
    // why: a replaced load that takes itself for the recorded one, as an owner check that compared the wrong id would.
    return { ...port, updateProcessState: step => port.updateProcessState(current => {
      const before = decode(current)
      const own = [...run.ids].find(([, each]) => each === load)?.[0]
      if (!before || !own || run.scheduler.current() === load) return step(current as never)
      return { ...step({ ...before, loadId: own } as never) as unknown as ProcessState, loadId: before.loadId } as never
    }) }
  }
  return port
}

/**
 * Runs the current load's tick a full period on, as its own dispatch.
 * @param run - The run.
 * @returns Once run as far as it can.
 */
async function tick(run: Run): Promise<void> {
  await run.scheduler.advance(tickMs)
  const load = run.scheduler.current()
  if (!load?.tick || load.isCancelled) return
  load.resetMoment()
  const work = load.tick
  await run.scheduler.run(load, work)
}

/**
 * Builds the position of a unit waiting on its Verify config's approval, which the approval follower reads.
 * @param blob - The config's blob.
 * @returns The position.
 */
const waitingOn = (blob: string): Position => ({ verify: { isWaitingApproval: true, approvalBlob: blob, approval: null } }) as unknown as Position

/**
 * Runs one event.
 * @param run - The run.
 * @param step - The event.
 * @returns Once dispatched and settled as far as it can.
 */
async function perform(run: Run, step: Step): Promise<void> {
  const { truth, world, scheduler } = run
  const rule = aliases[step] ?? step
  const ruleMatch = /^(hold|park|fail|lose|on|off):(.+)$/.exec(rule)
  if (ruleMatch) {
    const [, mode, cls] = ruleMatch as unknown as [string, RuleMode | 'on' | 'off', OpClass]
    if (mode === 'off') scheduler.rules.splice(0, scheduler.rules.length, ...scheduler.rules.filter(each => !(each.cls === cls && each.isSticky)))
    else scheduler.rules.push({ mode: mode === 'on' ? 'fail' : mode, cls, isSticky: mode === 'on' })
    await scheduler.runDeferred()
    return
  }
  if (!['reload', 'restart', 'upgrade'].includes(step)) await scheduler.runDeferred()
  const isTurnLive = (): boolean => truth.turn !== null && truth.turn !== 'entering'
  // why: a start is an obligation once its keep lands, whatever the command answers; the answer is judged against that landing.
  const keep = async (kind: 'coordinate' | 'step'): Promise<void> => {
    truth.seq += 1
    const token = `${kind === 'coordinate' ? 'start' : 'step'}#${truth.seq}#`
    const { done } = await dispatch(run, port => submitStart(port, kind === 'coordinate' ? { kind, text: token } : { kind, lead: token }))
    void done.then(reason => {
      const isLanded = run.keptOrder.has(token)
      if (reason === null && !isLanded) violate(run, 'I5', `the command said ${token} was kept, and its keep never landed`)
      if (typeof reason === 'string' && isLanded && /was not kept/.test(reason)) violate(run, 'I5', `the command said ${token} was not kept, and its keep landed`)
    }, () => null)
    await scheduler.pump()
  }
  const actions: Record<string, () => Promise<unknown>> = {
    keep: () => keep('coordinate'),
    step: () => keep('step'),
    turn: async () => { if (truth.turn === null) await enter(run, 'typed', true) },
    type: async () => { if (truth.turn === null) await enterPrompt(run, 'typed', true) },
    begin: async () => { if (truth.turn === 'entering') await startTurn(run) },
    end: async () => { const turnId = truth.turn; if (turnId && isTurnLive()) { truth.turn = null; await endTurn(run, turnId, false) } },
    'turn-failed': async () => { if (truth.turn === null) { scheduler.rules.push({ mode: 'fail', cls: 'state-write', isSticky: false }); await enter(run, 'typed', true) } },
    'end-failed': async () => {
      const turnId = truth.turn
      if (!turnId || !isTurnLive()) return
      truth.turn = null
      scheduler.rules.push({ mode: 'fail', cls: 'state-write', isSticky: false })
      await endTurn(run, turnId, false)
    },
    'overlap-failed': async () => {
      const ended = truth.turn
      if (!ended || !isTurnLive()) return
      scheduler.rules.push({ mode: 'fail', cls: 'state-write', isSticky: false })
      await startTurn(run)
      await endTurn(run, ended, false)
    },
    // why: an upgrade reload from a version that kept no process state, in the middle of that version's turn: the host holds no process state, and the records name this process and its running turn.
    upgrade: async () => {
      const own = await stampHost(createTestPort(world))
      await startModule(run, 'upgrade', () => {
        if (own) world.files.set(`${records}/host/sid.json`, JSON.stringify(own))
        world.files.set(`${records}/activity/sid.json`, JSON.stringify({ v: 1, isTurn: true, at: world.clock.now(), isDialog: false }))
        truth.turn = 'upgraded'
      })
    },
    interrupt: async () => { const turnId = truth.turn; if (turnId && isTurnLive()) { truth.turn = null; await endTurn(run, turnId, true) } },
    // why: the engine ended the running turn and started the next, but the mod hears the next one's start before the earlier one's end.
    overlap: async () => {
      const ended = truth.turn
      if (!ended || !isTurnLive()) return
      await startTurn(run)
      await endTurn(run, ended, false)
    },
    // why: the Stop's own answer is judged, as the agent reads it, against what happened by the time it answers.
    stop: async () => {
      const turn = truth.turn
      // why: the engine raises a turn's Stop only once its tool calls answered, and a send's tool call answers after it recorded the send.
      if (truth.sends.some(send => send.bound === turn)) return
      const load = scheduler.current()
      const { done } = await dispatch(run, port => handleStop(port, { stop_hook_active: false, background_tasks: [] } as never, (async () => ({})) as unknown as Next<'classic.Stop'>))
      void done.then(result => {
        const text = (result as { block?: string } | undefined)?.block ?? ''
        if (!text.includes('with no message to its coordinator')) return
        if (turn && truth.sent.has(turn)) violate(run, 'I5', `turn ${turn} sent a message, and its Stop says it sent none`)
        if (truth.sends.some(send => send.bound === turn)) violate(run, 'I5', `turn ${turn} has a send in flight, and its Stop says it sent none`)
        // why: a Stop decides from its last read of the state, so an attempt that turned unknown after it, as a load a reload started records, is not one it could have named.
        const readAt = load ? run.lastRead.get(load) ?? 0 : 0
        const held = (readState(world)?.attempts ?? []).filter(attempt => attempt.status.kind === 'unknown' && (run.unknownAt.get(attempt.id) ?? 0) <= readAt)
        if (held.length) violate(run, 'I5', 'a Stop says no message was sent while an attempt the hold row names is unresolved')
      }, () => null)
    },
    compact: () => dispatch(run, port => handleClassicSessionStart(port, { source: 'compact' } as never, (async () => ({})) as unknown as Next<'classic.SessionStart'>)),
    tool: () => dispatch(run, port => handleToolCall(port, { tool: 'Read', input: { file_path: '/repo/README.md' }, tool_use_id: 'read-1' } as never, async () => ({ result: 'read' }) as never)),
    // why: a send binds its turn before the message goes out, and records it once the message went out, which may be after its turn ended.
    send: async () => {
      if (!isTurnLive()) return
      const send: Send = { bound: truth.turn }
      truth.sends.push(send)
      const { done } = await dispatch(run, port => bindSend(port))
      void done.then(turnId => { send.turnId = turnId as string | null }, () => { truth.sends.splice(truth.sends.indexOf(send), 1) })
      await scheduler.pump()
    },
    sent: async () => {
      const send = truth.sends.findLast(each => each.turnId !== undefined)
      if (!send || send.turnId === undefined) return
      truth.sends.splice(truth.sends.indexOf(send), 1)
      if (send.bound) truth.sent.add(send.bound)
      const turnId = send.turnId
      await dispatch(run, port => markSent(port, turnId))
    },
    wake: async () => {
      const blob = `blob${truth.wakes.length + 1}`
      truth.wakes.push({ blob, process: truth.process })
      world.files.set(`${records}/ok/${blob}.json`, '{"v":1}')
      await dispatch(run, port => followApproval(port, waitingOn(blob), true))
    },
    doorbell: () => dispatch(run, port => submitAttempt(port, { owner: readLoadId(), route: 'doorbell', subject: 'doorbell', kind: 'step', label: 'the mailbox doorbell prompt',
      text: doorbellText, isWanted: () => true })),
    conclude: async () => {
      if (truth.concludedAt !== null) return
      truth.concludedAt = run.step
      const held = await world.directSessionState.readSessionState()
      // why: the flow is derived from the unit's declaration, so a session that names no unit has no current step.
      if (held.value) await world.directSessionState.writeSessionState({ ...held.value, unit: undefined } as never, held.version)
    },
    // why: a reload into this version from the version before attempts, which left two starts of unknown outcome and one it held in flight.
    migrate: async () => {
      const value = world.processState.value as Record<string, unknown> | undefined
      if (!value) return
      const ids = [`u${truth.migrated.length + 1}`, `u${truth.migrated.length + 2}`]
      truth.migrated.push(...ids.map(id => ({ id, process: truth.process })))
      const earlier = Array.isArray(value.unknownStarts) ? value.unknownStarts as unknown[] : []
      world.processState.value = { ...value, unknownStarts: [...earlier, ...ids.map(id => ({ id, kind: 'step', cause: 'held by an earlier version, whether it entered is unknown', label: `migrated start ${id}` }))] }
      await startModule(run, 'reload')
    },
    ok: () => answer(run, 'ok'),
    drop: () => answer(run, 'drop'),
    fail: () => answer(run, 'fail'),
    time: () => scheduler.advance(tickMs),
    tick: () => tick(run),
    paint: () => dispatch(run, port => refreshView(port)),
    reload: () => startModule(run, 'reload'),
    restart: () => startModule(run, 'process'),
    resume: () => scheduler.resume('oldest'),
    cut: async () => { scheduler.cut() },
    'resume-new': () => scheduler.resume('newest'),
    fresh: async () => { run.isFresh = true },
    open: async () => { run.pane.isOpen = true; run.isPaneClosed = false },
    close: async () => { run.pane.isOpen = false; run.isPaneClosed = true },
    'render-short': () => render(run, { rows: 3, offset: 0 }),
    'render-scrolled': () => render(run, { rows: 200, offset: 40 }),
    'drop-prompt': async () => { if (truth.turn === 'entering') { truth.turn = null; truth.stranded = truth.enteringBy } },
    runlog: async () => { world.paneViews.push('run-log') },
    flow: async () => { world.paneViews.push('flow') },
    render: () => render(run),
    // why: a process state of a shape this version does not know, as a newer version could leave.
    foreign: async () => { world.processState.value = { v: 99, foreign: true } },
    // why: a submit that bypasses the gate and writes no attempt, for the checker's own test only; no alphabet holds it.
    rogue: () => dispatch(run, port => port.submitPrompt(`rogue start#${truth.seq + 1}#`)),
  }
  await (actions[rule] ?? (async () => {}))()
  await scheduler.pump()
}

/**
 * Draws the Flow pane as the host does while it is open, as a dispatch of the current load, through a window of the given rows from the
 * given offset, and judges what a completed render of the Flow view drew. A Run log render draws no Flow view, and a closed pane draws
 * nothing. Only a render whose window shows the whole view counts its notices as drawn: the explorer's views stay well under its rows,
 * while a short or scrolled window may leave any of them out of sight.
 * @param run - The run.
 * @param window - The body's rows and the scroll offset.
 * @returns Once drawn as far as it can.
 */
async function render(run: Run, window: { rows: number; offset: number } = { rows: 200, offset: 0 }): Promise<void> {
  if (!run.pane.isOpen) return
  const drawn: { view?: unknown; pane?: string } = {}
  const isWhole = window.rows >= 200 && window.offset === 0
  // why: the offscreen mutation hands the mod a window that shows everything, while the explorer judges the one the host drew.
  const told = run.mutation === 'offscreen-ack' ? { rows: 200, offset: 0 } : window
  const { done } = await dispatch(run, port => handlePaneRender({ ...port,
    readView: async () => { const view = await port.readView(); drawn.view ??= view; return view },
    readPaneView: async () => { const pane = await port.readPaneView(); drawn.pane ??= pane; return pane },
  }, paneElements, { bodyColumns: 80, scroll: { offset: told.offset, bodyRows: told.rows } } as never, new AbortController().signal))
  void done.then(() => { if (drawn.pane === 'flow') noteRender(run, JSON.stringify(drawn.view ?? ''), isWhole) }, () => null)
  await run.scheduler.pump()
}

/**
 * Tells what a drawn notice's words say of its obligation's outcome.
 * @param words - The words drawn for it.
 * @returns What they say.
 */
const readSaid = (words: string): Said => words.includes('it was not started') ? 'unstarted' : words.includes('the engine dropped it') ? 'dropped'
  : words.includes('it entered, after') ? 'entered' : 'unknown'

/**
 * Tells what a notice of the process state says of its outcome, as its words do.
 * @param notice - The notice.
 * @returns What it says.
 */
const readNoticeSaid = (notice: Notice): Said => notice.outcome ?? (notice.cause.startsWith('it was not started') ? 'unstarted' : 'unknown')

/**
 * Tells whether the turn ran at a moment of the run's order, from the turn changes noted so far.
 * @param run - The run.
 * @param order - The moment.
 * @returns The turn running then, null when none, 'entering' while a prompt entered.
 */
const readTurnAt = (run: Run, order: number): string | null => run.turnHistory.filter(each => each.order <= order).at(-1)?.turn ?? null

/**
 * Judges a completed render of the Flow view, each fact against what was true when the view's observation was read: a running turn is
 * never drawn as the unit waiting for approval, every attempt unresolved by then is named, a claim the engine never received is never
 * said to have been submitted, a notice's established outcome is the one the engine answered, a keep that landed is never said not kept,
 * a load the state records is never said to be unrecorded, and no recovery promises a delivery the reload hold withholds. A render
 * whose window showed the whole view notes which notices it drew, each with what its words said of its outcome.
 * @param run - The run.
 * @param text - What the render drew.
 * @param isWhole - Whether its window showed the whole view.
 */
function noteRender(run: Run, text: string, isWhole: boolean): void {
  run.order += 1
  // why: a notice a render drew stays drawn, so the ids gather across renders, while the text is the last render's.
  const rendered: Rendered = { text: isWhole ? text : run.rendered.text, order: run.order, ids: new Set(run.rendered.ids), causes: new Map(run.rendered.causes) }
  run.rendered = rendered
  const state = readState(run.world)
  const notes = (JSON.parse(text) as { notes?: { value: string }[] } | null)?.notes ?? []
  for (const notice of isWhole ? state?.notices ?? [] : []) {
    const isOverflow = notice.id.startsWith(overflowPrefix)
    const words = notes.find(note => note.value.includes(`[${shortId(notice.id)}]`) && (!isOverflow || note.value.includes(notice.label)))?.value
    if (words === undefined) continue
    const said = isOverflow ? 'unknown' : readSaid(words)
    rendered.ids.add(notice.id)
    rendered.ids.add(notice.subject)
    rendered.ids.add(`${notice.id}|${notice.label}`)
    rendered.causes.set(notice.id, { said, order: run.order })
    const answer = run.truth.submits.find(submit => submit.attempt?.id === notice.id)
    if ((said === 'entered' || said === 'dropped') && (answer?.status ?? 'none') !== (said === 'entered' ? 'ok' : 'drop')) {
      violate(run, 'I5', `notice ${shortId(notice.id)} is drawn ${said}, while the engine answered ${answer?.status ?? 'nothing'}`)
    }
  }
  if (text.includes('records no turn change for the coordinator')) run.promise = { activity: run.world.files.get(`${records}/activity/sid.json`) }
  if (/records itself and delivers them/.test(text)) violate(run, 'I5', 'the pane promises that a reload delivers the waiting starts, which the reload hold withholds until a turn boundary')
  for (const [token] of run.keptOrder) if (notes.some(note => note.value.includes(token) && note.value.includes('was not kept'))) violate(run, 'I5', `the pane says ${token} was not kept, and its keep landed`)
  if (!state) return
  const current = run.scheduler.current()
  if (text.includes('could not record this load') && state.loadId && run.ids.get(state.loadId) === current) violate(run, 'I5', 'the pane says this load is not recorded, while the state records it')
  const observedAt = run.view?.observedAt ?? run.order
  const turn = readTurnAt(run, observedAt)
  if (turn !== null && turn !== 'entering' && text.includes('"symbol":"●"')) violate(run, 'I5', `turn ${turn} ran when the view was observed, and the pane shows the unit waiting for approval`)
  const isUnreadable = text.includes('the process state cannot be read')
  for (const attempt of state.attempts ?? []) {
    const id = shortId(attempt.id)
    const becameUnknown = run.unknownAt.get(attempt.id)
    if (!isUnreadable && becameUnknown !== undefined && becameUnknown < observedAt && attempt.status.kind === 'unknown' && !text.includes(`[${id}]`)) violate(run, 'I5', `unresolved attempt ${id} is not shown`)
    const sentence = text.slice(text.indexOf(`[${id}]`), text.indexOf(`[${id}]`) + 160)
    const isSubmitted = run.truth.submits.some(each => each.attempt?.id === attempt.id)
    if (text.includes(`[${id}]`) && !isSubmitted && /\bwas submitted\b/.test(sentence)) violate(run, 'I5', `attempt ${id} is said to have been submitted, though the engine never received it`)
  }
}

/**
 * Checks every process-state write that landed since the last check: a load the state does not record changes nothing but an attempt's
 * outcome, a notice of a late outcome and the turn evidence, and records itself only over none or an older load; no write lowers the
 * turn epoch, empties or changes the generation, regresses an established outcome, replaces a pending wake, or deletes a kept start, an
 * attempt or a wake with no outcome and no notice that resolves it, an overflow notice covering only what it folded; a notice leaves
 * only once a completed render of the Flow view drew it, an overflow at the very count it drew. Then checks the session mirror never
 * goes back to an older session record.
 * @param run - The run.
 */
function checkWrites(run: Run): void {
  const writes = run.scheduler.writes.slice(run.writesSeen)
  run.writesSeen = run.scheduler.writes.length
  for (const write of writes) {
    const before = write.before === undefined ? null : decodeProcessState(write.before)
    const after = write.after === undefined ? null : decodeProcessState(write.after)
    if (!after) continue
    const writer = [...run.ids].find(([, load]) => load === write.load)?.[0]
    if (after.generation === '') violate(run, 'I6', `load ${write.load.n} wrote a state with no generation`)
    if (!before) continue
    if (before.generation && after.generation !== before.generation) violate(run, 'I6', `load ${write.load.n} changed the generation`)
    if (after.epoch < before.epoch) violate(run, 'I6', `load ${write.load.n} lowered the epoch from ${before.epoch} to ${after.epoch}`)
    const notices = new Map((after.notices ?? []).map(notice => [notice.id, notice]))
    const earlierNotices = before.notices ?? []
    const isEstablished = (attempt: Attempt): boolean => attempt.status.kind === 'entered' || attempt.status.kind === 'dropped'
    const noticed = new Set((after.notices ?? []).flatMap(notice => [notice.id, notice.subject]))
    // why: a claim the engine never received may be withdrawn, as a claim whose write answered with a failure is.
    const deletedAttempts = (before.attempts ?? []).filter(earlier => !after.attempts?.some(each => each.id === earlier.id) && !isEstablished(earlier) && !notices.has(earlier.id)
      && (earlier.status.kind !== 'pending' || run.truth.submits.some(submit => submit.attempt?.id === earlier.id)))
    const subjects = new Set(deletedAttempts.map(attempt => attempt.subject))
    const settled = new Set((before.attempts ?? []).filter(attempt => attempt.status.kind === 'entered' && attempt.route === 'start').map(attempt => attempt.subject))
    const deletedKept = readKeptStarts(before).filter(kept => !readKeptStarts(after).some(each => each.id === kept.id) && !settled.has(kept.id) && !noticed.has(kept.id) && !subjects.has(kept.id))
    const wakeEntered = (before.attempts ?? []).some(attempt => attempt.route === 'wake' && attempt.subject === before.pendingWake && attempt.status.kind === 'entered')
    const deletedWake = before.pendingWake && after.pendingWake !== before.pendingWake && !wakeEntered && !noticed.has(before.pendingWake) && !subjects.has(before.pendingWake) ? before.pendingWake : null
    const goneNotices = earlierNotices.filter(notice => !notices.has(notice.id))
    const covered = noteFold(run, earlierNotices, after.notices ?? [], [...goneNotices.flatMap(notice => [notice.id, notice.subject]), ...deletedAttempts.flatMap(attempt => [attempt.id, attempt.subject]),
      ...deletedKept.map(kept => kept.id), ...deletedWake ? [deletedWake] : []], goneNotices.filter(notice => !notice.id.startsWith(overflowPrefix)).length + deletedAttempts.length + deletedKept.length + (deletedWake ? 1 : 0))
    for (const notice of goneNotices.filter(each => !covered.has(each.id))) {
      const isSeen = notice.id.startsWith(overflowPrefix) ? run.rendered.ids.has(`${notice.id}|${notice.label}`) : run.rendered.ids.has(notice.id)
      const drawn = run.rendered.causes.get(notice.id)?.said
      if (!isSeen) violate(run, 'I5', `notice ${shortId(notice.id)} (${notice.label}) left the state, though no completed render of the Flow view drew it`)
      else if (!notice.id.startsWith(overflowPrefix) && drawn !== readNoticeSaid(notice)) violate(run, 'I4', `notice ${shortId(notice.id)} left saying ${readNoticeSaid(notice)}, though the last render that drew it said ${drawn ?? 'nothing'}`)
    }
    for (const attempt of deletedAttempts.filter(each => !covered.has(each.id))) violate(run, 'I4', `attempt ${shortId(attempt.id)} was deleted with no outcome and no notice`)
    for (const kept of deletedKept.filter(each => !covered.has(each.id))) violate(run, 'I4', `kept start ${shortId(kept.id)} was deleted with no outcome and no notice`)
    if (deletedWake && !covered.has(deletedWake)) violate(run, 'I4', `the pending wake ${deletedWake} was replaced or cleared before it entered`)
    for (const notice of after.notices ?? []) if (/will not be recorded/.test(notice.cause) && run.scheduler.loads.some(load => load.process === run.truth.process && !load.isGone && load !== run.scheduler.current())) {
      violate(run, 'I5', `notice ${shortId(notice.id)} says its answer will not be recorded, while the load that submitted it may still record it`)
    }
    if (before.loadId !== writer) {
      const owner = before.loadId ? run.ids.get(before.loadId) : undefined
      // why: a load whose first look already named the newer load takes it for the one it replaces, the documented first-read limit.
      const firstLook = run.scheduler.firstReads.get(write.load)
      const isLateLook = !!firstLook && decodeProcessState(firstLook)?.loadId === before.loadId
      const isClaim = after.loadId === writer && (before.loadId === undefined || !!owner && owner.n < write.load.n || isLateLook)
      const strip = (state: ProcessState): string => JSON.stringify({ ...state, loadId: undefined, loadBeat: undefined, turn: undefined, prompt: undefined, epoch: undefined,
        legacy: undefined, endedTurns: undefined, turnEndKeys: undefined, notices: undefined, receipts: undefined, attempts: (state.attempts ?? []).map(attempt => ({ ...attempt, status: undefined })) })
      if (!isClaim && strip(before) !== strip(after)) violate(run, 'I6', `load ${write.load.n}, which the state does not record, changed more than outcomes and turn evidence`)
      const addedNotices = (after.notices ?? []).filter(notice => !earlierNotices.some(each => each.id === notice.id && each.cause === notice.cause))
      if (!isClaim && addedNotices.some(notice => !(before.attempts ?? []).some(attempt => attempt.id === notice.id) && !earlierNotices.some(each => each.id === notice.id) && !run.truth.submits.some(submit => submit.attempt?.id === notice.id))) {
        violate(run, 'I6', `load ${write.load.n}, which the state does not record, added a notice of no submit of its own`)
      }
      if (after.loadId !== before.loadId && !isClaim) violate(run, 'I6', `load ${write.load.n} recorded itself over a load it does not replace`)
    }
    for (const earlier of before.attempts ?? []) {
      const later = after.attempts?.find(each => each.id === earlier.id)
      if (later && isEstablished(earlier) && later.status.kind !== earlier.status.kind) violate(run, 'I6', `attempt ${shortId(earlier.id)} lost its established outcome`)
    }
  }
  checkMirror(run)
}

/**
 * Notes what an overflow notice a write folded covers: the notices it folded away and the obligations the write ended with no notice of
 * their own, only when the overflow's count grew by at least as many, and what an overflow it replaced covered.
 * @param run - The run.
 * @param before - The notices before the write.
 * @param after - The notices after it.
 * @param ended - The ids and subjects of the notices gone and the obligations ended with no notice of their own.
 * @param count - How many notices those make, the replaced overflow left out.
 * @returns What the fold covers, empty when the write folded nothing.
 */
function noteFold(run: Run, before: readonly Notice[], after: readonly Notice[], ended: readonly string[], count: number): Set<string> {
  const countOf = (notice: Notice | undefined): number => notice ? Number(/^(\d+)/.exec(notice.label)?.[1] ?? 0) : 0
  const overflow = after.find(notice => notice.id.startsWith(overflowPrefix))
  const earlier = before.find(notice => notice.id.startsWith(overflowPrefix))
  const isFold = !!overflow && (earlier?.id !== overflow.id || earlier.label !== overflow.label) && countOf(overflow) - countOf(earlier) >= count
  if (!overflow || !isFold) return new Set()
  const covered = new Set([...ended, ...earlier ? [earlier.id, ...run.covers.get(earlier.id) ?? []] : []])
  run.covers.set(overflow.id, new Set([...run.covers.get(overflow.id) ?? [], ...covered]))
  return covered
}

/**
 * Checks the session mirror and its revision: within a generation the revision never goes back, and the mirror never holds a session
 * record older than one it held before.
 * @param run - The run.
 */
function checkMirror(run: Run): void {
  const held = run.world.sessions.get('sid')
  if (held) {
    const text = JSON.stringify(held)
    if (!run.sessions.has(text)) run.sessions.set(text, run.sessions.size)
  }
  const mirror = run.world.files.get(`${records}/s/sid.json`)
  const order = mirror === undefined ? undefined : run.sessions.get(mirror)
  if (order !== undefined) {
    if (order < run.mirrored.version) violate(run, 'I6', `the session mirror went back to an older session record (${order} after ${run.mirrored.version})`)
    run.mirrored.version = Math.max(run.mirrored.version, order)
  }
  const revision = JSON.parse(run.world.files.get(`${records}/s/sid.rev`) ?? 'null') as { generation: string; version: number } | null
  const last = run.mirrored.revision
  if (revision && last && revision.generation === last.generation && revision.version < last.version) violate(run, 'I6', `the mirror revision went back from ${last.version} to ${revision.version}`)
  if (revision) run.mirrored.revision = revision
}

/**
 * Runs rounds of rest: suspended calls resume, every submit still pending answers as entered, the running turn ends, deferred work runs,
 * a tick runs a full period later, and the pane, open on its Flow view, is painted and drawn.
 * @param run - The run.
 * @param rounds - How many.
 * @returns Once they ran.
 */
async function settleRounds(run: Run, rounds: number): Promise<void> {
  if (rounds === 0) return
  while (run.scheduler.parked.some(each => !each.load.isGone)) await run.scheduler.resume('oldest')
  while (run.truth.sends.some(each => each.turnId !== undefined)) await perform(run, 'sent')
  for (const submit of run.truth.submits.filter(each => each.status === 'pending' && each.load.process === run.truth.process)) if (submit.status === 'pending') await answer(run, 'ok')
  // why: a prompt that entered starts its turn, as the engine starts it at once.
  if (run.truth.turn === 'entering') await startTurn(run)
  const turnId = run.truth.turn
  if (turnId) {
    run.truth.turn = null
    await endTurn(run, turnId, false)
  }
  await run.scheduler.runDeferred()
  await tick(run)
  await run.scheduler.runDeferred()
  await perform(run, 'paint')
  await render(run)
  noteKeptIds(run)
  checkWrites(run)
  await settleRounds(run, rounds - 1)
}

/**
 * Names what holds the session at rest that only the user can resolve, each as the hold row must name it: an attempt whose outcome is
 * unknown, or pending with no submit of the current load awaiting it, by its id; the uncertainty of a load a reload started that heard no
 * turn start, turn end or prompt since; and a load that stood down.
 * @param run - The run.
 * @param state - The process state.
 * @returns What the hold row must say for each, empty when nothing holds.
 */
function readUserHolds(run: Run, state: ProcessState | null): string[] {
  const current = run.scheduler.current()
  const recorded = state?.loadId ? run.ids.get(state.loadId) : undefined
  const attempts = (state?.attempts ?? []).filter(attempt => attempt.status.kind === 'unknown' || attempt.status.kind === 'pending'
    && !run.truth.submits.some(submit => submit.attempt?.id === attempt.id && submit.load === current && submit.status === 'pending')).map(attempt => `[${shortId(attempt.id)}]`)
  const isReloadHeld = !!current && run.truth.reloaded.has(current) && !run.truth.heardBoundary.has(current)
  // why: a value of a shape this version does not know holds the session until a new process, the documented recovery.
  const isForeign = run.world.processState.value !== undefined && !state
  // why: a load whose first look raced a replaced load's late record stands down, the documented first-read limit, which a reload resolves.
  const isStoodDown = !!current && !!recorded && recorded !== current
  const isUnregistered = !!current && run.unregistered.has(current)
  const isStranded = !!current && run.truth.stranded === current
  return [...attempts, ...isReloadHeld ? ['started by a reload'] : [], ...isStoodDown ? ['stands down'] : [], ...isForeign ? ['cannot use its process state'] : [],
    ...isUnregistered ? ['did not register'] : [], ...isStranded ? ['its turn has not started'] : []]
}

/**
 * Checks, at rest, what must hold of every obligation: a start whose keep landed and that entered is kept no more; one that did not enter
 * still waits, held only by something only the user can resolve that the drawn hold row names, or ended with a notice a completed render
 * drew or the state still holds; an answer the engine gave is never lost: its attempt holds it, or its start entered, still waits, or
 * leaves with a notice that does not call it unknown; the same for wakes and migrated outcomes.
 * @param run - The run.
 * @param phase - Whether the user has taken over yet: before, only evidence of the mod's own may move an obligation.
 */
function checkRest(run: Run, phase: 'autonomous' | 'manual'): void {
  const state = readState(run.world)
  // why: the load that runs owns the pane at rest, under a state of a shape this version does not know too, unless it stood down.
  const current = run.scheduler.current()
  if (run.view && current && run.view.load !== current && !run.isPaneClosed && !readUserHolds(run, state).includes('stands down') && !(run.isLateClaimExcused && run.lateClaims.has(run.view.load))) {
    violate(run, 'I5', `the pane shows the view load ${run.view.load.n} published, not the current load ${current.n}'s`)
  }
  // why: a value of a shape this version does not know replaced the state and every obligation it held, as a newer version's would; only its hold row is judged.
  if (!state && run.world.processState.value !== undefined) {
    // why: a closed pane shows nothing; a fault's hold is the pane's and /flow status's to show.
    const unnamed = run.isPaneClosed ? [] : readUserHolds(run, state).filter(hold => !run.rendered.text.includes(hold))
    if (unnamed.length) violate(run, 'I5', `the session is held at rest, and the drawn hold row does not name ${unnamed.join(', ')}`)
    return
  }
  const kept = state ? readKeptStarts(state) : []
  const notices = state?.notices ?? []
  const holds = readUserHolds(run, state)
  const isStoodDown = holds.includes('stands down')
  const isCoveredNow = (id: string): boolean => notices.some(notice => run.covers.get(notice.id)?.has(id)) || [...run.rendered.ids].some(key => run.covers.get(key)?.has(id))
  const isNoticed = (id: string | null, token: string): boolean => !!id && (run.rendered.ids.has(id) || notices.some(notice => notice.subject === id || notice.id === id) || isCoveredNow(id)
    || [...run.rendered.causes.keys()].some(key => notices.find(notice => notice.id === key)?.subject === id)) || run.rendered.text.includes(token)
  // why: a hold reaches the user on the drawn Flow view while the pane is open; while it is closed, a hold no fault caused reaches them through a notification, while one a fault caused is the pane's and /flow status's to show.
  const isFaultless = (hold: string): boolean => hold === 'started by a reload' || hold === 'its turn has not started' || hold === 'stands down'
  const notified = run.world.notifications.join('\n')
  const shown = run.isPaneClosed ? notified : run.rendered.text
  // why: a load that stood down publishes no view, so it says so through a notification whether the pane is open or not.
  const unnamed = holds.filter(hold => (!run.isPaneClosed || isFaultless(hold)) && !shown.includes(hold) && !(hold === 'stands down' && notified.includes(hold)))
  const isHeld = holds.length > 0
  for (const start of run.truth.kept.filter(each => each.process === run.truth.process)) {
    const id = start.id
    const isKept = kept.some(each => each.id === id)
    if (isEntered(run.truth, start.token)) {
      if (isKept && !isStoodDown) violate(run, 'I4', `start ${start.seq} entered but is still kept (${describeState(state)}, ${phase})`)
      continue
    }
    if (isKept) {
      if (phase === 'autonomous' && !isHeld) violate(run, 'I7', `start ${start.seq} still waits at rest, with nothing only the user can resolve (${describeState(state)})`)
      if (phase === 'manual' && !isStoodDown) violate(run, 'I7', `start ${start.seq} still waits after the user took over`)
      continue
    }
    if (!isNoticed(id, start.token)) violate(run, 'I4', `start ${start.seq} neither entered nor waits, and no notice says why`)
  }
  // why: an answer the load never heard is owed only once its prompt was seen entering, the one evidence of it the load can have.
  for (const submit of run.truth.submits.filter(each => (each.status === 'ok' || each.status === 'drop') && each.attempt && each.load.process === run.truth.process && (!each.isLost || each.isSeen))) {
    const id = submit.attempt?.id ?? ''
    const attempt = state?.attempts?.find(each => each.id === id)
    if (attempt) {
      if (attempt.status.kind === 'unknown' || attempt.status.kind === 'pending') violate(run, 'I4', `a ${submit.route} attempt answered ${submit.status} is still ${attempt.status.kind}`)
      continue
    }
    if (run.settled.has(id)) continue
    // why: an answer that came after its attempt ended is the engine's established outcome, owed to the user apart from any notice: a notice kept says it, or a render after the answer drew it.
    const said = submit.status === 'ok' ? 'entered' : 'dropped'
    const notice = notices.find(each => each.id === id)
    const drawn = run.rendered.causes.get(id)
    const isKept = !!notice && readNoticeSaid(notice) === said || drawn !== undefined && drawn.order > (submit.answeredAt ?? 0) && drawn.said === said
    if (!isKept) violate(run, 'I4', `a ${submit.route} attempt the engine answered ${submit.status} left with that outcome neither kept nor drawn`)
  }
  for (const wake of run.truth.wakes.filter(each => each.process === run.truth.process)) {
    const isWakeEntered = run.truth.submits.some(each => each.route === 'wake' && each.attempt?.subject === wake.blob && each.status === 'ok')
    if (isWakeEntered || isNoticed(wake.blob, wake.blob)) continue
    if (state?.pendingWake === wake.blob) {
      if (phase === 'autonomous' && !isHeld) violate(run, 'I7', `the wake for ${wake.blob} still waits at rest, with nothing only the user can resolve (${describeState(state)})`)
      continue
    }
    if (state?.wokenBlobs.includes(wake.blob) || !state && !isHeld) violate(run, 'I4', `the wake for ${wake.blob} was lost`)
  }
  for (const { id } of run.truth.migrated.filter(each => each.process === run.truth.process)) {
    const isHolding = state?.attempts?.some(attempt => attempt.id === `unknown:${id}`)
    if (isHolding && phase === 'manual') violate(run, 'I7', `migrated start ${id} still holds after the user took over`)
    if (!isHolding && !isNoticed(`unknown:${id}`, `migrated start ${id}`)) violate(run, 'I4', `migrated start ${id} left with no notice`)
  }
  if ((state ? kept.length || state.pendingWake : isHeld) && unnamed.length) violate(run, 'I5', `the session is held at rest, and the drawn hold row does not name ${unnamed.join(', ')}`)
}

/**
 * Words what the state holds that may hold the session, for a violation's detail.
 * @param state - The process state.
 * @returns The words.
 */
const describeState = (state: ProcessState | null): string => state
  ? `turn ${state.turn ? state.turn.id || 'carried' : 'none'} at epoch ${state.epoch}, ended ${(state.endedTurns ?? []).join('/') || 'none'}, ${state.legacy ? 'legacy unresolved, ' : ''}attempts ${(state.attempts ?? []).map(attempt => attempt.status.kind).join('/') || 'none'}`
  : 'state unknown'

/**
 * Brings the run to rest with every fault gone and the pane open on its Flow view, first with no help from the user, then as the user
 * takes over by typing a prompt, and checks what must hold at each.
 * @param run - The run.
 * @returns Once checked.
 */
async function quiesce(run: Run): Promise<void> {
  run.step = -1
  run.scheduler.rules.splice(0, run.scheduler.rules.length)
  // why: a pane the schedule closed stays closed at rest, where a hold must reach the user without it.
  run.pane.isOpen = !run.isPaneClosed
  run.world.paneViews.push('flow')
  await settleRounds(run, 6)
  checkRest(run, 'autonomous')
  const current = run.scheduler.current()
  const state = readState(run.world)
  // why: the documented recoveries: the user types a prompt, and a load that stood down, or whose tools did not register, is resolved by a reload.
  if (state?.loadId && current && run.ids.get(state.loadId) !== current || current && run.unregistered.has(current)) await startModule(run, 'reload')
  if (run.truth.turn === null) await enter(run, 'typed at rest', true)
  await settleRounds(run, 4 + run.truth.kept.length)
  checkRest(run, 'manual')
}

/**
 * Builds the world the explorer runs in: a delegated Fix unit whose diagnosis waits for its approval, so a step start composes a prompt
 * until the unit concludes, and its Stop asks for a message to its coordinator when its turn sent none.
 * @param on - The test's hook registration.
 * @returns The world.
 */
export function createExplorerWorld(on: Parameters<typeof createWorld>[0]): World {
  const world = createWorld(on, { branch: 'fix' }, {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
    unit: { runs: [diagnoseRuns[0]!] }, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
  })
  seedDelegation(world, 'coord', [1])
  return world
}

/**
 * Runs one schedule from a fresh session start and checks every invariant during it and at rest.
 * @param world - A world of its own for this schedule.
 * @param schedule - The events.
 * @param mutation - A defect to inject at the hooks' boundary, for a mutation check; none by default.
 * @param isLateClaimExcused - Whether the views of a load whose suspended number claim landed after a newer load started are excused, the recorded limit; a check of that excuse runs without it.
 * @returns What broke, empty when nothing did.
 */
export async function runSchedule(world: World, schedule: readonly Step[], mutation: Mutation | null = null, isLateClaimExcused = true): Promise<Violation[]> {
  const run: Run = {
    world, scheduler: createScheduler(world, records), violations: [], step: 0, ports: new Map(), ids: new Map(), writesSeen: 0, order: 0, keptOrder: new Map(), claimedIdle: new Map(), isFresh: false,
    rendered: { text: '', order: 0, ids: new Set(), causes: new Map() }, pane: { isOpen: false }, covers: new Map(), sessions: new Map(), mirrored: { version: -1, revision: null }, promise: null, mutation, lateClaims: new Set(), isLateClaimExcused,
    unregistered: new Set(), lastRead: new Map(), view: null, turnHistory: [], settled: new Set(), unknownAt: new Map(), isPaneClosed: false, attemptsSeen: new Map(), queued: [],
    truth: { turn: null, turns: 0, process: 0, pid: 300, sent: new Set(), sends: [], kept: [], seq: 0, submits: [], releases: [], entered: new Map(), concludedAt: null, wakes: [], migrated: [],
      reloaded: new Set(), heardBoundary: new Set(), enteringBy: null, stranded: null },
  }
  explorerStats.schedules += 1
  // why: every turn change is noted in the run's order as it happens, so a view is judged against the turn when it was observed.
  const turn = { value: null as string | null }
  Object.defineProperty(run.truth, 'turn', { get: () => turn.value, set: (value: string | null) => { turn.value = value; run.order += 1; run.turnHistory.push({ order: run.order, turn: value }) } })
  run.scheduler.onWrite = write => { noteWrite(run, write.before, write.after) }
  // why: the engine clock reads the wall time, so an epoch the mod takes from the time rises past any turn count, as it does in a session.
  await world.clock.set(sessionStartMs)
  await startModule(run, 'process')
  for (const [index, step] of schedule.entries()) {
    run.step = index
    await perform(run, step)
    noteKeptIds(run)
    checkWrites(run)
    checkActivity(run)
  }
  await quiesce(run)
  // why: a process that ended answers nothing, so its continuations stay pending; the next schedule's world is its own.
  run.scheduler.end(run.truth.process)
  explorerStats.lastFaults = run.scheduler.readFaults()
  return run.violations
}

/**
 * Checks what a coordinator reads of the unit: while a load a reload started has heard no turn boundary itself, whether a turn runs is
 * unknown to it, so the activity record never says idle while a turn runs.
 * @param run - The run.
 */
function checkActivity(run: Run): void {
  const current = run.scheduler.current()
  const isHeld = !!current && run.truth.reloaded.has(current) && !run.truth.heardBoundary.has(current)
  const record = JSON.parse(run.world.files.get(`${records}/activity/sid.json`) ?? 'null') as { isTurn?: boolean; isUnknown?: boolean } | null
  const turn = run.truth.turn
  // why: a call the schedule suspended may be the very publish that marks the record, so the record is judged once nothing is suspended.
  const isSuspended = run.scheduler.parked.some(each => !each.load.isGone)
  if (isHeld && !isSuspended && record && !record.isTurn && !record.isUnknown && turn !== null && turn !== 'entering') violate(run, 'I5', `the activity record says idle while turn ${turn} runs, and the load a reload started cannot know it`)
}

/**
 * Notes, as a write lands, the order of each start it kept and whether the session was idle for each claim it wrote.
 * @param run - The run.
 * @param before - The value before.
 * @param after - The value after.
 */
function noteWrite(run: Run, before: unknown, after: unknown): void {
  const earlier = before === undefined ? null : decodeProcessState(before)
  const later = after === undefined ? null : decodeProcessState(after)
  if (!later) return
  const tokenOf = (kept: KeptStart): string => kept.start.kind === 'coordinate' ? kept.start.text : kept.start.kind === 'step' ? kept.start.lead : ''
  const known = new Set(earlier ? readKeptStarts(earlier).map(tokenOf) : [])
  for (const kept of readKeptStarts(later)) {
    const token = tokenOf(kept)
    if (known.has(token) || run.keptOrder.has(token)) continue
    run.keptOrder.set(token, { order: run.keptOrder.size, process: run.truth.process })
    const seq = Number(/#(\d+)#/.exec(token)?.[1] ?? 0)
    run.truth.kept.push({ seq, token, kind: token.startsWith('step') ? 'step' : 'coordinate', process: run.truth.process, id: kept.id, at: run.world.clock.now() })
  }
  const claims = new Set((earlier?.attempts ?? []).map(attempt => attempt.id))
  for (const attempt of later.attempts ?? []) if (!claims.has(attempt.id)) run.claimedIdle.set(attempt.id, run.truth.turn === null)
  for (const attempt of later.attempts ?? []) if (attempt.status.kind === 'unknown' && !run.unknownAt.has(attempt.id)) run.unknownAt.set(attempt.id, run.order)
  for (const attempt of later.attempts ?? []) if (!run.attemptsSeen.has(attempt.id)) run.attemptsSeen.set(attempt.id, attempt)
  // why: an attempt that leaves holding an established outcome was settled, which carries its answer into the start or wake it ended.
  for (const attempt of earlier?.attempts ?? []) {
    if (!later.attempts?.some(each => each.id === attempt.id) && (attempt.status.kind === 'entered' || attempt.status.kind === 'dropped')) run.settled.add(attempt.id)
  }
}

/**
 * Learns the keeping's id of each start kept since, by its token.
 * @param run - The run.
 */
function noteKeptIds(run: Run): void {
  const state = readState(run.world)
  if (!state) return
  for (const kept of readKeptStarts(state)) {
    const token = kept.start.kind === 'coordinate' ? kept.start.text : kept.start.kind === 'step' ? kept.start.lead : ''
    const start = run.truth.kept.find(each => each.token === token && each.id === null)
    if (start) start.id = kept.id
  }
}

/**
 * Tells whether an event can act after a prefix, so the enumeration skips schedules whose events do nothing: a turn starts only when none
 * runs, ends and overlaps need one running, answers need a kept start, and a resume needs a held write.
 * @param prefix - The events before it.
 * @param step - The event.
 * @returns Whether it can act.
 */
function canAct(prefix: readonly Step[], step: Step): boolean {
  const isRunning = prefix.reduce((running, each) => ['turn', 'turn-failed'].includes(each) ? true : ['end', 'end-failed'].includes(each) ? false : running, false)
  const holds = prefix.filter(each => each === 'stall').length - prefix.filter(each => each === 'release').length
  if (step === 'turn' || step === 'turn-failed') return !isRunning
  if (['end', 'end-failed', 'overlap', 'overlap-failed'].includes(step)) return isRunning
  if (step === 'release') return holds > 0
  if (step === 'ok' || step === 'drop') return prefix.includes('keep')
  return true
}

/**
 * Lists every schedule of a given length over an alphabet whose events can each act, in a fixed order.
 * @param alphabet - The events.
 * @param depth - The length.
 * @returns The schedules.
 */
export function enumerate(alphabet: readonly Step[], depth: number): Step[][] {
  return depth === 0 ? [[]] : enumerate(alphabet, depth - 1).flatMap(prefix => alphabet.filter(step => canAct(prefix, step)).map(step => [...prefix, step]))
}

/**
 * Draws schedules from a seeded generator, so a run is replayed exactly from its seed.
 * @param seed - The seed.
 * @param count - How many schedules.
 * @param length - How long each is.
 * @param alphabet - The events.
 * @returns The schedules.
 */
function drawSchedules(seed: number, count: number, length: number, alphabet: readonly Step[] = fullAlphabet): Step[][] {
  const state = { value: seed >>> 0 || 1 }
  // why: a 32-bit xorshift, so a seed names the same schedules on every machine.
  const next = (): number => {
    state.value ^= state.value << 13
    state.value ^= state.value >>> 17
    state.value ^= state.value << 5
    state.value >>>= 0
    return state.value
  }
  return Array.from({ length: count }, () => Array.from({ length }, () => alphabet[next() % alphabet.length] ?? 'tick'))
}

/**
 * Shrinks a failing schedule to one where removing any single event no longer breaks the same invariant.
 * @param schedule - The failing schedule.
 * @param invariant - The invariant it breaks.
 * @param check - Runs a schedule in a world of its own.
 * @returns The shrunk schedule.
 */
async function shrink(schedule: readonly Step[], invariant: Violation['invariant'], check: (candidate: readonly Step[]) => Promise<Violation[]>): Promise<Step[]> {
  for (const index of schedule.keys()) {
    const candidate = schedule.filter((_, each) => each !== index)
    if ((await check(candidate)).some(violation => violation.invariant === invariant)) return shrink(candidate, invariant, check)
  }
  return [...schedule]
}

/**
 * Words a failure as a replayable report.
 * @param seed - The seed, or null for an enumerated or named schedule.
 * @param schedule - The shrunk schedule.
 * @param violations - What it broke.
 * @returns The report.
 */
const describeFailure = (seed: number | null, schedule: readonly Step[], violations: readonly Violation[]): string =>
  `${seed === null ? '' : `seed ${seed}: `}replay with runSchedule(world, ${JSON.stringify(schedule)}): ${violations.map(each => `${each.invariant} at step ${each.step}: ${each.detail}`).join('; ')}`

/**
 * Runs schedules, each in a world of its own, and words each that broke an invariant with its schedule shrunk to the fewest events; a
 * gated exploration reports a red of the follow-up class beside the results instead of failing on it.
 * @param on - The test's hook registration.
 * @param schedules - The schedules.
 * @param seed - The seed that drew them, or null.
 * @param isGated - Whether reds of the follow-up class are reported apart; a named regression is never gated.
 * @returns The failures, each replayable.
 */
export async function explore(on: Parameters<typeof createExplorerWorld>[0], schedules: readonly (readonly Step[])[], seed: number | null, isGated = true): Promise<string[]> {
  const check = (schedule: readonly Step[]): ReturnType<typeof runSchedule> => runSchedule(createExplorerWorld(on), schedule)
  const failures: string[] = []
  for (const schedule of schedules) {
    const first = (await check(schedule))[0]
    if (!first) continue
    const shrunk = await shrink(schedule, first.invariant, check)
    const failure = describeFailure(seed, shrunk, await check(shrunk))
    if (!isGated || !isFollowUpClass(explorerStats.lastFaults)) {
      failures.push(failure)
      continue
    }
    // why: a red that needs what the stopping rule sends to a tracked follow-up is reported beside the results, never hidden and never a pass.
    explorerStats.followUps += 1
    const host = globalThis as { console?: { log: (text: string) => void } }
    host.console?.log(`explorer follow-up class (two faults, or a suspension across a reload plus a fault): ${failure}`)
  }
  return failures
}

/**
 * Tells whether a replay is of the class the stopping rule sends to a tracked follow-up, from what the schedule actually did to it: two
 * faults or more, or a fault with a call that was still suspended as a load started, by a reload, restart, upgrade or migration. A fault
 * is a `fail:`, `lose:` or `on:` rule, or an event whose write fails, that fired; a suspension, a `hold:` or `park:` rule, is slowness
 * rather than a fault.
 * @param record - What the schedule did to the replay.
 * @returns Whether it is.
 */
export function isFollowUpClass(record: FaultRecord): boolean {
  return record.faults >= 2 || record.faults >= 1 && record.isSuspendedAcrossLoad
}

/**
 * Splits a seed's random schedules into the chunks one test runs each: the normal suite's, and a soak run's more after them, so a soak
 * of any size runs one seed per file, each file within the runner's bound on one file.
 * @param seed - The seed.
 * @returns Each chunk's test name and schedules.
 */
export function drawChunks(seed: number): { name: string; schedules: Step[][] }[] {
  const drawn = drawSchedules(seed, randomCount + soakPerSeed, randomLength)
  return Array.from({ length: Math.ceil(drawn.length / chunkSize) }, (_, chunk) => ({
    name: `random schedules ${chunk * chunkSize + 1}-${Math.min(drawn.length, (chunk + 1) * chunkSize)} of seed ${seed} hold every invariant`,
    schedules: drawn.slice(chunk * chunkSize, (chunk + 1) * chunkSize),
  }))
}
