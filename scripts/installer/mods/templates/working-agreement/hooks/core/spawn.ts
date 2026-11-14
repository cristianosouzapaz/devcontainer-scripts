import { findWorktreeRoot, readGitOutput, readParentBranch, readRoot, readWorktrees, readWorktreeStatus, runGit } from '../lib/git'
import { bodyLimit, unitAddress } from '../domain/mail'
import { describeOwedCancels } from '../domain/instruction'
import { appendInstructions } from '../domain/messages'
import { removeFile } from '../lib/files'
import { isNonEmptyString, isRecord, isSafeInteger } from '../lib/guards'
import { parseJson, readJsonUnlessStrict, readText } from '../lib/json'
import { executeProcess, hasExitedZero, runProcess } from '../lib/process'
import { createQueue } from '../lib/queue'
import { fail, formatErrorLine, settle, succeed, unwrapOr } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { outsideHerdr } from './herdr-worktrees'
import { describeMailFault, isMailAnswered, mailPath, readMailState, readOwedMailOrFault, sendMail } from './mailbox'
import { recordPlaced } from './placed-refs'
import { atomicReplace, readCommonDir, readSessionMirrors, recordsPath, UnwrittenError } from './record-store'
import { readGit } from './repository'
import { createSpawnEffects } from './spawn-effects'
import type { Effect, EffectKind, Failure, SpawnEffects } from './spawn-effects'
import { isStopped, stop, unknown } from '../domain/outcome'
import { isSameProcess, readSessionLiveness } from './session-host'
import { sessionMemory } from './session-memory'
import { unitArgs } from './unit-args'
import { readUnitHost, unitAgent } from './unit-host'
import type { UnitHost, UnitWorkspace } from './unit-host'
import { findUnitBranch, readDefaultBase, readIssueStart, readUnitState } from './unit-state'
import { moduleState } from '../lib/module-state'
import { hostLockPath, readHostLock, withHostLock } from './host-lock'
import type { HeldLock } from './host-lock'
import { UnansweredRenameError } from './host-lock'

/** The model and effort a unit runs on, and why; both absent, the user's own defaults. */
export interface UnitLevel { model?: string; effort?: Effort; reason?: string }

/**
 * How spawn started a unit: the permission mode it recorded, absent on a record that predates it, the level the unit runs on, and the
 * branch spawn cut its unit branch from, absent when spawn did not create that branch or the record predates it.
 */
interface SpawnStart { mode?: string; level: UnitLevel; base?: string }

/**
 * What spawn's cap reads from the host: every spawned workspace, and those that hold a machine slot, or why they could not be counted;
 * the count is skipped, and empty, for an issue whose own workspace is open.
 */
interface Capacity { workspaces: UnitWorkspace[]; running: Result<UnitWorkspace[]> }

/**
 * Whether the cap lets an issue's unit start now: its own open workspace is reused outside the cap, else a slot must be free; unknown
 * when the host could not be read or counted.
 */
export type Slot = { kind: 'reuse'; workspace: UnitWorkspace } | { kind: 'free' | 'full'; running: UnitWorkspace[]; limit: number } | { kind: 'unknown'; reason: string }

/**
 * What a spawn decided before its unit's session starts: the record and level it starts from, its workspace, branch and base, whether a
 * close merge_child put off is pending, whether its session already runs, and the start assignment.
 */
interface UnitStart {
  escalation?: string; progress: Progress; level: UnitLevel; runOn: UnitLevel; own?: UnitWorkspace; branch: string; cutFrom?: string
  isClosing: boolean; isLive: boolean; body: string
}

/** A spawn step's outcome: its value, or its failure, which the effect state classifies once the steps settle. */
type Step<T> = { isOk: true; value: T } | { isOk: false; failure: Failure }

/** The base a unit's spawn record holds: where spawn cut its branch, none recorded, or unknown because the record cannot be read. */
export type RecordedBase = { kind: 'cut'; base: string } | { kind: 'none' } | { kind: 'unknown'; reason: string }

/**
 * What a unit's session has been through, so a re-run resumes it instead of starting it twice, the permission mode it last started in,
 * the level it runs on, the reason of an escalation the coordinator asked for while the unit worked, the session it runs as, the start
 * assignment sent to its mailbox and why it was closed without a done, and whether merge_child integrated it while it worked, so its
 * session is closed once that turn ends.
 */
export interface Progress extends UnitLevel {
  isStarted: boolean; isPrompted: boolean; assignId?: string; assignClosed?: string; mode?: string; escalation?: string; isClosing?: boolean
  /**
   * The session the unit runs as, its one recorded identity: delegation, its mailboxes, retire and the declaring check read it, a resume
   * and an escalation resume it, and a handoff rewrites it to the session that continues the unit. The derived id only names the first
   * session of a fresh spawn, and the session of a started record written before this field existed.
   */
  sessionId?: string
  /**
   * The sessions handoffs superseded, oldest first: each was cleared in the process that went on as the next one, so its mirror still
   * declares the unit and its process still runs, and the declaring check must not take it for another session.
   */
  predecessors?: string[]
  /** The last escalation failure the coordinator's tick told it of, so a failure that repeats each tick is told once. */
  escalationFailure?: string
  /** An escalation failure notice the coordinator's tick has not yet delivered, written before its send and cleared after it. */
  escalationUndelivered?: string
  /** When spawn first started the unit's session, ISO 8601: a delegated decision older than it belongs to an earlier unit of the issue. */
  startedAt?: string
  /** The branch spawn cut the unit branch from, written only when spawn created that branch, so it is never guessed afterwards. */
  base?: string
}

/**
 * How a host start ended: the session reported started, or a start error with a workspace open, each with the call that settles the
 * start; or a start that did not happen or opened no workspace, with why.
 */
type StartOutcome = { kind: 'started'; close: (effect?: Effect) => void } | { kind: 'failed'; error: string; close: (effect?: Effect) => void }
  | { kind: 'not-started'; failure: Failure }

/** What the host's start takes. */
type StartRequest = Parameters<UnitHost['start']>[1]

/** The message a starting session takes first: its start assignment, or the inform that resumes it while that assignment is open. */
interface StartMessage { kind: 'assign' | 'inform'; id: string }

/** A unit branch spawn created, with the branch it cut it from, absent when another spawn created it first. */
interface CreatedBranch { branch: string; base?: string }

/**
 * What a spawn did about its start message: sent one now, waited on one already in the unit's mailbox, or sent none because the
 * session was live or its start assignment is closed.
 */
type StartDisposition = { kind: 'sent' | 'reused'; message: StartMessage } | { kind: 'live' | 'closed' } | { kind: 'unknown'; detail: string }

/**
 * What a spawn answered, what it did about the unit's start message, and the host's start error when nothing after it, an ack or
 * a look at the session, proved the session runs.
 */
interface Spawned { text: string; disposition: StartDisposition; unprovenStart?: string }

/** A spawn stopped because the unit's mailbox could not be read, its session settled: the stop, with what the spawn did, for an escalation's notice. */
interface Withheld { isOk: false; error: string; isStopped: true; spawned: Spawned }

/** How a spawn's locked steps ended, as the effect state classifies them. */
type Resumed = Result<Spawned> | Withheld

/** Whether a spawn starts an issue's session now: yes, no, or unknown with why it could not be told. */
export type Starting = { kind: 'yes' | 'no' } | { kind: 'unknown'; reason: string }

/** A spawn's start marker for one issue: writes it before the host start, removes it, and tells why its last removal failed. */
interface StartMarker { write: () => Promise<void>; remove: () => Promise<void>; error: () => string | null }

/** What the mod saw of a unit's session once its escalation's resume failed: closed by it, running, not running, or unread. */
export type SessionSeen = { kind: 'closed' | 'runs' | 'not-running' } | { kind: 'unknown'; reason: string }

/**
 * An escalation under way on the unit's record: the model its resume passed, null for the account's default, whether its idle session
 * was closed for it, whether its new level was recorded, how the resume ended, and the session as seen once the resume failed.
 */
export interface Escalation { model: string | null; isClosed: boolean; isLevelRecorded: boolean; resumed: Resumed; seen: SessionSeen }

/** An effort a coordinator may give a unit; xhigh and max stay the user's to ask for. */
type Effort = typeof efforts[number]

/** A Conventional Commit title prefix, its type captured. */
const conventionalPrefix = /^([a-z]+)(\([^)]*\))?!?:\s*/i
// why: The RFC 4122 URL namespace, so the same repository and issue always give the same session id.
const namespace = '6ba7b8119dad11d180b400c04fd430c8'
const lockWaitMs = 30000
// why: sessions older than the host lock break the legacy spawn lock at this age, longer than a spawn's model check, host start and ack wait add up to.
const staleLockMs = 600000
// why: a unit acks its assign in the first turn a ring or the tick starts after its session start, which a loaded machine can bring later than the host's own start wait.
/** How long after its send, which follows its session's host start, a unit's start assignment must get its transport ack. */
const assignAckMs = 120000
// why: bypassPermissions would lift every engine check in a session nobody watches; plan would stall it; anything unknown fails closed.
const inheritedModes = ['default', 'acceptEdits', 'auto']
/** The efforts a coordinator may pick for a unit. */
export const efforts = ['low', 'medium', 'high'] as const
// why: an unknown model still opens an interactive session, which fails only at its first prompt; a one-turn print run fails up front, and with no settings source but the project's, run from /, the probe loads no plugin or hook and touches no repository.
const probeTimeoutMs = 60000
// why: a closed session's conversation stays on disk, so the restart resumes it; its host is given this long to end it.
export const exitWaitMs = 30000
/** How long a unit's working agent is given to go idle before an escalation is put off. */
export const busyWaitMs = 1000
const spawnQueue = moduleState(() => ({ run: createQueue() }))
const spawnConfig = { limit: 4, continueAtUsageLimit: false }
/** The changes an ack timeout's answer names itself: the message, its records and a closed workspace. */
const ackTimeout: EffectKind[] = ['message', 'assign', 'record', 'workspace']
/** How a spawn refusal made before any change ends. */
const nothingChanged = '; nothing was changed; spawn it again'

/**
 * Sets how many spawned units may run at once, from the plugin's configuration.
 * @param limit - The configured cap; anything but a positive integer keeps the default.
 */
export function setSpawnLimit(limit: unknown): void {
  if (isSafeInteger(limit) && limit > 0) spawnConfig.limit = limit
}

/**
 * Sets whether unit sessions wait out a usage limit and continue on their own, from the plugin's configuration.
 * @param value - The configured option; anything but true leaves it off.
 */
export function setContinueAtUsageLimit(value: unknown): void {
  spawnConfig.continueAtUsageLimit = value === true
}

/**
 * Opens, reopens or reuses the unit session of an issue in its own herdr worktree; every step first checks whether it is done,
 * so a re-run after a crash completes a half-created unit.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param instructions - The coordinator's text for this unit, appended verbatim to its start prompt; empty appends nothing.
 * @param level - The model and effort the coordinator picks for a unit not yet started, with its reason; a started unit keeps its recorded one.
 * @returns What the unit is now, or why it is not: refused only when nothing changed, stopped naming what changed, or not finished.
 */
export async function spawnUnit(port: EnginePort, issue: number, instructions = '', level: UnitLevel = {}): Promise<Result<string>> {
  const effects = createSpawnEffects(issue)
  // why: only the host check, the repository reads and the lock's acquisition run outside the classified steps, and none of them changes anything.
  const spawned = await (async (): Promise<Resumed> => {
    const host = await readUnitHost(port)
    if (!host) return fail(outsideHerdr)
    return withSpawnLock(port, (common, root) => spawnLocked(port, host, common, root, issue, instructions, level,
      createStartMarker(port, common, issue, effects), effects), nothingChanged)
  })().catch((error: unknown) => fail(`${formatErrorLine(error)}${nothingChanged}`))
  return spawned.isOk ? succeed(spawned.value.text) : spawned
}

/**
 * Runs work that creates or removes units while this process holds the repository's spawn lock, so it never races a spawn.
 * @param port - The engine calls.
 * @param work - What runs under the lock, given the git common directory, this session's checkout and the held lock, whose rename
 * lands a record only while the lock is still held.
 * @param tail - What a caller adds to a refusal made before the lock, such as that nothing changed.
 * @returns What the work returns, or why it did not run.
 */
export async function withSpawnLock<R extends Result<unknown>>(port: EnginePort, work: (common: string, root: string, held: HeldLock) => Promise<R>,
  tail = ''): Promise<R | Result<never>> {
  const common = await readCommonDir(port)
  const root = await readRoot(port.processes)
  // why: a root git could not be asked for is unknown, never a sign that this session is outside a repository.
  if (!root.isOk) return fail(`the repository root could not be read: ${root.error}${tail}`)
  if (!common || !root.value) return fail(`this session is not in a git repository${tail}`)
  const checkout = root.value
  return spawnQueue.run(() => holdLock(port, common, held => work(common, checkout, held)))
}

/**
 * Runs the spawn steps while this process holds the repository's spawn lock, and classifies how they ended from the call's effect state:
 * the start assignment goes to the unit's mailbox once its session's host start returns, so its doorbell starts the first turn only after
 * the host saw the session ready, and spawn fails loudly unless it is acknowledged within assignAckMs of that send.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param common - The git common directory.
 * @param root - The coordinator's checkout, which the host creates worktrees from.
 * @param issue - The issue number.
 * @param instructions - The coordinator's text for the start assignment.
 * @param chosen - The level the coordinator picks, used only by a unit never started.
 * @param marker - The issue's start marker, which stands from the host start until the start message is sent and is removed on every exit.
 * @param effects - The call's effect state, which every step records its changes in.
 * @param resumeModel - The model an escalated resume passes explicitly, since a resumed session otherwise keeps the one it ran on; never recorded.
 * @returns What the unit is now, or why it is not started, as the effect state classifies it.
 */
async function spawnLocked(port: EnginePort, host: UnitHost, common: string, root: string, issue: number, instructions: string,
  chosen: UnitLevel, marker: StartMarker, effects: SpawnEffects, resumeModel?: string): Promise<Resumed> {
  const settled = await settle(spawnSteps(port, host, common, root, issue, instructions, chosen, marker, effects, resumeModel))
  await marker.remove()
  // why: the effect state alone tells what changed, so a throw is classified as a returned failure is; only its refusal adds that nothing changed.
  if (!settled.isOk) return effects.classify({ error: settled.error, refusal: `${settled.error}${nothingChanged}` })
  if (!settled.value.isOk) return effects.classify(settled.value.failure)
  const spawned = settled.value.value
  // why: a start message withheld for an unread mailbox fails the spawn, for the tool and the escalation alike; its text names the session's state.
  if (spawned.disposition.kind === 'unknown') {
    const classified = effects.classify({ error: spawned.text, covers: ['start'] })
    return !classified.isOk && isStopped(classified) ? { isOk: false, error: classified.error, isStopped: true, spawned } : classified
  }
  const error = marker.error()
  // why: a marker removal with no known result leaves the marker's state unknown, so the spawn did not finish, naming the session it started.
  if (effects.isPending('marker')) return effects.classify({ error: error ?? 'its removal did not answer' })
  if (!error) return succeed(spawned)
  return succeed({ ...spawned, text: `${spawned.text}; its start marker could not be removed (${error}), so until this spawn returned unit_prompt would refuse `
    + `#${issue} as starting; the next spawn lock hold removes it` })
}

/**
 * Runs the spawn steps of {@link spawnLocked}, which removes the start marker whatever way they end: the reads and pure checks first,
 * then the branch cut, then the writes and the start.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param common - The git common directory.
 * @param root - The coordinator's checkout.
 * @param issue - The issue number.
 * @param instructions - The coordinator's text for the start assignment.
 * @param chosen - The level the coordinator picks, used only by a unit never started.
 * @param marker - The issue's start marker.
 * @param effects - The call's effect state.
 * @param resumeModel - The model an escalated resume passes explicitly.
 * @returns What the unit is now, or why it is not started.
 * @throws When a read or the host fails, the change under way left unresolved.
 */
async function spawnSteps(port: EnginePort, host: UnitHost, common: string, root: string, issue: number, instructions: string,
  chosen: UnitLevel, marker: StartMarker, effects: SpawnEffects, resumeModel?: string): Promise<Step<Spawned>> {
  const declaring = await findDeclaringSession(port, issue)
  if (declaring) return failed(describeDeclaring(issue, declaring))
  const slot = judgeSlot(await readCapacity(port, host, issue), issue)
  if (slot.kind === 'unknown') return failed(`running units unknown: ${slot.reason}`)
  const own = slot.kind === 'reuse' ? slot.workspace : undefined
  if (slot.kind === 'full') {
    return failed(`${slot.running.length} units already run, the cap is ${slot.limit}: ${slot.running.map(workspace => `#${workspace.issue} (${workspace.path})`).join(', ')}`)
  }
  // why: a request is kept only for a unit below the top level, so a stale one never survives a rewrite.
  const { isClosing, escalation, ...stored } = await readProgressFile(port, common, issue, true)
  const level = stored.isStarted ? pickLevel(stored) : pickLevel(chosen)
  const runOn = resumeModel ? { ...level, model: resumeModel } : level
  // why: checked before the branch and worktree exist, so a wrong name starts nothing.
  if (!stored.isStarted && level.model) {
    const probed = await probeModel(port, level.model)
    if (!probed.isOk) return failed(probed.error)
  }
  const found = await findUnitBranch(port, issue)
  if (found && !found.isOk) return failed(found.error)
  const made: Step<CreatedBranch> = found ? succeed({ branch: found.value }) : await createUnitBranch(port, issue, effects)
  if (!made.isOk) return made
  const { branch, base: cutBase } = made.value
  // why: only the spawn that cut the branch knows its base; a branch found already there keeps the base its record holds, or none.
  const cutFrom = cutBase ?? stored.base
  const progress = { ...stored, ...cutFrom ? { base: cutFrom } : {} }
  // why: written right after the cut as part of it, so every later rewrite of the record, a failed start's restore included, starts from it.
  if (cutBase) {
    const unwritten = await writeTracked(port, common, issue, { ...progress, ...escalation ? { escalation } : {}, ...isClosing ? { isClosing } : {} }, effects, null)
    if (unwritten) {
      return failed(`#${issue}'s branch ${branch} was created from ${cutBase}, but its spawn record could not take that base (${unwritten}), so no session `
        + `was started; check the cut with \`git reflog show ${branch} | tail -1\`. A later spawn reuses the branch and reads "base not recorded"`, { covers: ['cut'] })
    }
    const reflog = `\`git reflog show ${branch} | tail -1\``
    effects.supersede('cut', { kind: 'cut', clause: `created #${issue}'s branch ${branch} from ${cutBase}, recorded that base in its spawn record, and keeps it`,
      check: reflog, next: `check it with ${reflog}, then spawn again once the cause is fixed` })
  }
  // why: a lenient read shows a malformed pane list as no session, which would start a second session beside a live one.
  const isLive = await host.state(port, own, 0, true) !== 'none'
  const { paneId } = await port.readHerdrEnv()
  const body = appendInstructions(`Work on issue #${issue} on branch ${branch}: `
    + `read it with its comments (\`gh issue view ${issue} --comments\`), declare its flow, and work only in this worktree. The coordinator is herdr pane ${paneId}.`, instructions)
  // why: checked before any record write and before the session starts, since the assignment is sent only once it runs.
  if (body.length > bodyLimit) return failed(`the start assignment is ${body.length} characters, over the ${bodyLimit} a message carries: put the rest in an issue comment and send its URL`)
  return startUnit(port, host, common, root, issue, instructions, chosen, marker, effects,
    { ...escalation ? { escalation } : {}, progress, level, runOn, own, branch, cutFrom, isClosing: !!isClosing, isLive, body })
}

/**
 * Runs the spawn steps after the unit's branch exists: starts or reuses its session, sends its start message and waits for the ack.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param common - The git common directory.
 * @param root - The coordinator's checkout, which the host creates worktrees from.
 * @param issue - The issue number.
 * @param instructions - The coordinator's text for the start assignment.
 * @param chosen - The level the coordinator picks, used only by a unit never started.
 * @param marker - The issue's start marker, which stands from the host start until the start message is sent.
 * @param effects - The call's effect state.
 * @param start - What the spawn decided before this step.
 * @returns What the unit is now, or why it is not started.
 * @throws When a record or the host fails, the change under way left unresolved.
 */
async function startUnit(port: EnginePort, host: UnitHost, common: string, root: string, issue: number, instructions: string,
  chosen: UnitLevel, marker: StartMarker, effects: SpawnEffects, start: UnitStart): Promise<Step<Spawned>> {
  const { escalation, progress, level, runOn, own, branch, cutFrom, isClosing, isLive, body } = start
  // why: a handoff rebinds the record to the session that continues the unit, so a recorded id is never replaced by the derived one.
  const session = progress.sessionId ?? await deriveSessionId(common, issue)
  const mode = isLive ? progress.mode : inheritMode(sessionMemory.permissionMode)
  const kept = { ...level, ...escalation && !isTopLevel(level) ? { escalation: escalation } : {}, mode, sessionId: session,
    startedAt: progress.startedAt ?? new Date(await port.now()).toISOString() }
  const named = { ...progress, ...escalation ? { escalation: escalation } : {}, sessionId: session }
  // why: the unit finds its mailbox by this record's session id, and a spawn wants the unit live; a start's record write carries both, a live session gets its own write.
  if (isLive && (isClosing || progress.sessionId !== session)) {
    const clause = isClosing ? `dropped #${issue}'s pending close from its spawn record${progress.sessionId === session ? '' : ' and recorded its session id there'}`
      : `recorded #${issue}'s session id in its spawn record`
    const unwritten = await writeTracked(port, common, issue, named, effects, { kind: isClosing ? 'close' : 'session', clause })
    if (unwritten) return failed(unwritten)
  }
  // why: work under a lock this process lost may race another spawn, so no session is started.
  if (!isLive && sessionMemory.spawnLockLost?.aborted) {
    const text = `#${issue}'s session was not started: this process lost the spawn lock before the host start`
    return failed(text, { refusal: `${text}, so nothing was changed; spawn it again` })
  }
  // why: a session that never took a prompt saved no conversation, and claude refuses to resume one it cannot find; the host's start wait only guesses whether the session came up; the ack, or a live session, proves it, so its error alone is not fatal.
  const started = isLive ? { kind: 'live' as const } : await startSession(port, host, common, issue, { ...progress, ...kept, isStarted: true }, marker, effects, {
    root, issue, branch: branch, workspace: own, argv: [...unitArgs({ mode: inheritMode(mode), continueAtUsageLimit: spawnConfig.continueAtUsageLimit }),
      ...levelFlags(runOn), await hasConversation(port, session) ?? progress.isStarted ? '--resume' : '--session-id', session] })
  if (started.kind === 'not-started') return { isOk: false, failure: started.failure }
  const resolveStart = started.kind === 'live' ? undefined : started.close
  const startEffect: Effect = { kind: 'start', clause: `${progress.isStarted ? 'resumed' : 'started'} #${issue}'s session` }
  const startError = started.kind === 'failed' ? started.error : null
  // why: a session already running may have been left unnamed by a start whose host wait failed, so a reuse names it too, once its start message is settled.
  const nameUnit = async (): Promise<void> => { if (isLive || startError) await nameSession(port, host, issue, effects) }
  // why: mail sent before the host saw the session idle would start its first turn during the host's start wait and fail it.
  const message = await stageStartMessage(port, common, issue, progress, isLive, level, body, effects).finally(marker.remove)
  const state = isLive ? 'runs' : startError ? `may not run (the host's start said: ${startError})` : 'was started'
  if (!message.isOk) return failed(`#${issue}'s session ${state}, but its start message could not be sent: ${message.error}`, { covers: ['start'] })
  const disposition = message.value
  if (disposition.kind === 'unknown') {
    // why: a strict look settles the start the unread mailbox left unproven; one that fails leaves it unresolved.
    const seen = resolveStart ? await settle(lookAtSession(port, host, issue)) : null
    if (seen?.isOk) resolveStart?.(seen.value === 'runs' ? startEffect : { kind: 'opened', clause: `opened #${issue}'s workspace, where no session runs` })
    return succeed({ disposition, text: `#${issue}'s session ${state}, but ${disposition.detail}`, ...!isLive && startError ? { unprovenStart: startError } : {} })
  }
  const sent = disposition.kind === 'sent' || disposition.kind === 'reused' ? disposition.message : null
  const assigned = sent?.kind === 'assign' ? { assignId: sent.id } : {}
  if (!sent) await nameUnit()
  if (sent) {
    const waits = sent.kind === 'assign' ? { next: `a later spawn waits for this same message; check unit_read ${issue} before spawning again` } : {}
    const unrecorded = await writeTracked(port, common, issue, isLive ? { ...named, ...assigned } : { ...progress, ...kept, ...assigned, isStarted: true }, effects,
      { kind: 'assign', clause: sent.kind === 'assign' ? 'recorded that message in its spawn record' : `recorded #${issue}'s resume in its spawn record`, ...waits })
    if (unrecorded) {
      return failed(unrecorded, disposition.kind === 'sent' && sent.kind === 'assign' ? { after: ', but its spawn record does not hold that id',
        next: `check unit_read ${issue} and ${mailPath(common, unitAddress(issue))} before spawning again` } : {})
    }
    await nameUnit()
    // why: spawn's own start check, not a protocol deadline: the message gets no further attempt, retry or dead letter.
    const ack: { state: Awaited<ReturnType<typeof readMailState>> } = { state: 'none' }
    if (!await pollUntil(port, assignAckMs, 1000, async () => (ack.state = await readMailState(port, unitAddress(issue), sent.id)) === 'acknowledged')) {
      if (sent.kind === 'assign') {
        const unwritten = await writeTracked(port, common, issue, { ...progress, ...kept, ...assigned, isStarted: true, isPrompted: false }, effects,
          { kind: 'record', clause: 'recorded in its spawn record that the unit has not taken it' })
        if (unwritten) return failed(`#${issue}'s ${describeMessage(sent)} was not acknowledged, and its spawn record could not say so: ${unwritten}`)
      }
      const closed = isLive ? '' : await closeIfGone(port, host, issue, effects, resolveStart, startEffect)
      // why: a mailbox the poll could not read last tells nothing of the ack, so the session is not said to have taken no mail.
      if (ack.state === 'unknown') {
        return failed(`#${issue}'s ${describeMessage(sent)} was sent, but its mailbox could not be read when the ${assignAckMs / 1000} s ack wait ended, so whether `
          + `the unit took it is unknown${closed}; check ${mailPath(common, unitAddress(issue))} and unit_read. A later spawn waits for this same message and never sends a second one`,
        { covers: ackTimeout })
      }
      return failed(`#${issue} did not acknowledge its ${describeMessage(sent)} within ${assignAckMs / 1000} s of its send after the session's start${closed || ': its session '
        + 'took no mail, so it does not work on the issue. Read it with unit_read; a later spawn waits for this same message and never sends a second one'}`
        + `${startError ? ` (the host's start said: ${startError})` : ''}`, { covers: ackTimeout })
    }
    resolveStart?.(startEffect)
    const unwritten = await writeTracked(port, common, issue, { ...progress, ...kept, ...assigned, isStarted: true, isPrompted: true }, effects,
      { kind: 'ack', clause: 'recorded its acknowledgement in its spawn record' })
    if (unwritten) return failed(unwritten)
  } else if (startError) {
    const closed = await closeIfGone(port, host, issue, effects, resolveStart, startEffect)
    if (closed) return failed(`#${issue}'s session did not start${closed} (the host's start said: ${startError})`, { covers: ackTimeout })
  }
  // why: a unit already past its start assignment is mid-turn; text sent now would queue behind that turn, so the coordinator decides how to send it.
  const clauses = [progress.isPrompted && instructions ? '; its start assignment went earlier, so the instructions are not sent: send them with unit_prompt' : '',
    progress.isStarted && (chosen.model || chosen.effort) ? '; its recorded model and effort are kept, the ones given are ignored' : '']
  if (isLive) {
    return succeed({ disposition, text: `#${issue} already runs as herdr agent ${unitAgent(issue)} on ${branch}, ${describeBase(cutFrom ? { kind: 'cut', base: cutFrom } : { kind: 'none' }, branch)}${own ? `, in ${own.path}` : ''}`
      + `${[sent ? `; its ${describeMessage(sent)} was acknowledged now` : `; ${describeUnsent(disposition)}`, ...clauses].join('')}.` })
  }
  const standing = progress.isStarted ? await describeStanding(port, branch) : ''
  return succeed({ disposition, text: `#${issue} ${progress.isStarted ? 'resumed' : 'started'} as herdr agent ${unitAgent(issue)} on ${branch}, ${describeBase(cutFrom ? { kind: 'cut', base: cutFrom } : { kind: 'none' }, branch)}, in ${mode} mode, `
    + `${describeLevel(level)} (session ${session})${sent ? `, its ${describeMessage(sent)} acknowledged` : `; ${describeUnsent(disposition)}`}${[...clauses, standing].join('')}.` })
}

/**
 * Starts a unit's session through its host once its record says it started, so a session the host reports as failed but that runs
 * is already the unit's; a start marker stands until the start message is sent, so no other mail rings meanwhile. The record write and
 * the host start are one change, unresolved until an ack, a strict look or a strict listing settles it.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param common - The git common directory.
 * @param issue - The unit's issue.
 * @param record - The spawn record the started unit has.
 * @param marker - The issue's start marker, written before the host start.
 * @param effects - The call's effect state.
 * @param request - The host's start request, but for the checkout, which this start reads itself.
 * @returns How the start ended, with the call that settles it once it began; a start that opened no workspace leaves the record as it was.
 * @throws When a read fails, the start left unresolved once it began.
 */
async function startSession(port: EnginePort, host: UnitHost, common: string, issue: number, record: Progress, marker: StartMarker, effects: SpawnEffects,
  request: Omit<StartRequest, 'checkout'>): Promise<StartOutcome> {
  // why: the restore after a start that opened no workspace puts back these exact bytes, or no file where there was none.
  const before = await readText(port.files, progressPath(common, issue))
  // why: the host opens the checkout found here, so one found afterwards was created by this start only when none was found before.
  const checkout = request.workspace ? undefined : await readCheckout(port, request.branch)
  await marker.write()
  const unwritten = await writeTracked(port, common, issue, record, effects, null)
  if (unwritten) return { kind: 'not-started', failure: { error: unwritten, refusal: `${unwritten}${nothingChanged}` } }
  const close = effects.begin({ kind: 'start', what: `#${issue}'s session start was under way`, check: `unit_read ${issue} and plan` })
  const error = await host.start(port, { ...request, checkout }).then(() => null, (thrown: unknown) => formatErrorLine(thrown))
  if (!error) return { kind: 'started', close }
  if ((await host.list(port, true)).some(workspace => workspace.issue === issue)) return { kind: 'failed', error, close }
  const found = await readCheckout(port, request.branch).catch((thrown: unknown) => {
    throw new Error(`the host's start said: ${error}, and it opened no workspace; ${formatErrorLine(thrown)}`)
  })
  // why: with no workspace no session can run, so the record goes back to what it said before this start.
  const unrestored = await restoreRecord(port, common, issue, before, effects)
  await marker.remove()
  close(unrestored ? { kind: 'record', clause: `recorded #${issue} as started in its spawn record, which could not be put back (${unrestored})` } : undefined)
  const isCreated = !!found && !checkout && !request.workspace
  if (found && isCreated) effects.establish({ kind: 'checkout', clause: `created a checkout of ${request.branch} at ${found}` })
  const text = `#${issue}'s session was not started: its host opened no workspace for it (${error})`
  if (!found) return { kind: 'not-started', failure: { error: `${text}, and no checkout of ${request.branch} exists` } }
  const seen = `${text}, and a checkout of ${request.branch} exists at ${found}, ${isCreated ? 'created by this attempt' : 'which this call did not create'}`
  return { kind: 'not-started', failure: { error: seen, next: 'a later spawn opens that checkout', refusal: `${seen}; a later spawn opens it`, covers: ['checkout'] } }
}

/**
 * Puts an issue's spawn record back as it was before a start, as a tracked change: its exact text, or no file where there was none.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @param before - The record's text before the start, undefined when it had none.
 * @param effects - The call's effect state.
 * @returns Null once restored, or why it was not, the start's record left in place.
 * @throws When the restore's result is not established, its change left unresolved.
 */
async function restoreRecord(port: EnginePort, common: string, issue: number, before: string | undefined, effects: SpawnEffects): Promise<string | null> {
  const path = progressPath(common, issue)
  const close = effects.begin({ kind: 'record', what: `#${issue}'s spawn record was being put back`, check: path })
  if (before === undefined) {
    const removed = await removeFile(port.processes, path)
    // why: an rm that could not run or timed out may have removed the record or not.
    if (!removed.isOk) throw new Error(removed.error)
    close()
    const exited = hasExitedZero(removed, 'rm exited non-zero')
    return exited.isOk ? null : exited.error
  }
  try {
    await atomicReplace(port, path, before, undefined, sessionMemory.spawnLockHeld ?? undefined)
  } catch (error) {
    if (!(error instanceof UnwrittenError)) throw error
    close()
    return error.message
  }
  close()
  return null
}

/**
 * Replaces an issue's spawn record as a tracked change: unresolved until its result is known, then the change given, none when null.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @param progress - The whole record.
 * @param effects - The call's effect state.
 * @param effect - The change the write establishes, or null for a write another change stands for.
 * @returns Null once written, or why it was not, the record left as it was.
 * @throws When the write's result is not established, as after a rename whose call was cut, its change left unresolved.
 */
async function writeTracked(port: EnginePort, common: string, issue: number, progress: Progress, effects: SpawnEffects, effect: Effect | null): Promise<string | null> {
  const close = effects.begin({ kind: 'record', what: `#${issue}'s spawn record was being written`, check: progressPath(common, issue) })
  try {
    await writeProgress(port, common, issue, progress)
  } catch (error) {
    if (!(error instanceof UnwrittenError)) throw error
    close()
    return error.message
  }
  close(effect ?? undefined)
  return null
}

/**
 * Finds the checkout git lists for a branch, strictly.
 * @param port - The engine calls.
 * @param branch - The branch.
 * @returns The checkout's root, or undefined when git lists none.
 * @throws When git cannot list the worktrees: an unread list is never no checkout.
 */
async function readCheckout(port: EnginePort, branch: string): Promise<string | undefined> {
  const worktrees = await readWorktrees(port.processes)
  if (!worktrees) throw new Error(`\`git worktree list\` could not be read to find a checkout of ${branch}`)
  return worktrees.find(worktree => worktree.branch === `refs/heads/${branch}`)?.root
}

/**
 * Looks at a unit's session with reads that fail rather than guess.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param issue - The issue.
 * @returns Whether a session runs in its workspace.
 * @throws When the host cannot be read or answers malformed.
 */
async function lookAtSession(port: EnginePort, host: UnitHost, issue: number): Promise<'runs' | 'none'> {
  const own = (await host.list(port, true)).find(workspace => workspace.issue === issue)
  return own && await host.state(port, own, 0, true) !== 'none' ? 'runs' : 'none'
}

/**
 * Fails a spawn step.
 * @param error - Why it failed.
 * @param hints - How its answer words it beside the effect state.
 * @returns The failed step.
 */
function failed(error: string, hints: Omit<Failure, 'error'> = {}): Step<never> {
  return { isOk: false, failure: { error, ...hints } }
}

/**
 * Names the marker a spawn keeps while it starts an issue's session, until the start message is sent.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @returns The file path.
 */
function startingPath(common: string, issue: number): string {
  return recordsPath(common, 'spawn', `${issue}.starting`)
}

/**
 * Builds an issue's start marker for one spawn. Only a spawn lock holder writes one, and every hold removes those left before it, so
 * a marker counts only while the lock is held. It is a change of the call while it stands: one left in place is established, and one
 * whose write or removal has no known result is unresolved.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @param effects - The call's effect state.
 * @returns The marker, not yet written.
 */
function createStartMarker(port: EnginePort, common: string, issue: number, effects: SpawnEffects): StartMarker {
  const path = startingPath(common, issue)
  const state: { isOnDisk: boolean; error: string | null; settle?: (effect?: Effect) => void } = { isOnDisk: false, error: null }
  const left = (error: string): Effect => ({ kind: 'marker', clause: `left its start marker ${path} in place, since removing it failed (${error})`,
    next: 'the next spawn lock hold removes that marker; spawn it again' })
  return {
    // why: set before the write, so a write that failed part-way is still removed.
    write: async () => {
      state.isOnDisk = true
      const writing = effects.begin({ kind: 'marker', what: `#${issue}'s start marker ${path} was being written`, check: path })
      try {
        await atomicReplace(port, path, String(await port.now()))
      } catch (error) {
        if (!(error instanceof UnwrittenError)) {
          state.settle = writing
          throw error
        }
        writing()
        state.isOnDisk = false
        throw error
      }
      writing({ kind: 'marker', clause: `wrote its start marker ${path}` })
    },
    remove: async () => {
      if (!state.isOnDisk) return
      const removed = await removeFile(port.processes, path)
      state.settle?.()
      state.settle = undefined
      // why: an rm that could not run or timed out may have removed the marker or not, so the marker stays unresolved.
      if (!removed.isOk) {
        effects.retract('marker')
        state.settle = effects.begin({ kind: 'marker', what: `#${issue}'s start marker ${path} was being removed`, check: path })
        state.error = removed.error
        return
      }
      const exited = hasExitedZero(removed, 'rm exited non-zero')
      if (exited.isOk) {
        effects.retract('marker')
        Object.assign(state, { isOnDisk: false, error: null })
        return
      }
      effects.supersede('marker', left(exited.error))
      state.error = exited.error
    },
    error: () => state.error,
  }
}

/**
 * Removes every start marker an earlier spawn lock hold left: only a holder writes them, so each one found once the lock is taken is dead.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @returns Once none is left, or why one could not be listed or removed.
 */
async function clearStartMarkers(port: EnginePort, common: string): Promise<Result<void>> {
  const directory = recordsPath(common, 'spawn')
  const listed = await settle(port.files.list(directory))
  if (!listed.isOk) return await port.files.exists(directory).catch(() => true) ? fail(listed.error) : succeed(undefined)
  const paths = listed.value.filter(entry => entry.name.endsWith('.starting')).map(entry => `${directory}/${entry.name}`)
  if (!paths.length) return succeed(undefined)
  const removed = hasExitedZero(await removeFile(port.processes, ...paths), 'rm exited non-zero')
  return removed.isOk ? succeed(undefined) : removed
}

/**
 * Tells whether a spawn is starting an issue's session now: mail sent meanwhile would ring before the host saw the session ready.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns Yes while its start marker exists and the spawn lock is held, since every hold removes the markers left before it; no
 * without a marker or a held lock; unknown, with why, when the marker or the lock cannot be read or this process lost the lock it holds.
 */
export async function isUnitStarting(port: EnginePort, issue: number): Promise<Starting> {
  const common = await readCommonDir(port)
  if (!common) return { kind: 'no' }
  const path = startingPath(common, issue)
  const marker = await settle(readText(port.files, path))
  if (!marker.isOk) return { kind: 'unknown', reason: `its start marker ${path} could not be read: ${marker.error}` }
  if (marker.value === undefined) return { kind: 'no' }
  if (sessionMemory.spawnLockLost?.aborted) return { kind: 'unknown', reason: 'this session lost the spawn lock while its spawn ran' }
  const lock = await readHostLock(port, hostLockPath(common, 'spawn'))
  if (!lock.isOk) return { kind: 'unknown', reason: lock.error }
  return { kind: lock.value.isHeld ? 'yes' : 'no' }
}

/**
 * Tells whether a live process holds the repository's spawn lock, under which every spawn, close and retirement runs.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @returns Whether the kernel lock is held, or why it could not be read: an unread lock is never free.
 */
export async function isSpawnLockHeld(port: EnginePort, common: string): Promise<Result<boolean>> {
  const lock = await readHostLock(port, hostLockPath(common, 'spawn'))
  return lock.isOk ? succeed(lock.value.isHeld) : lock
}

/**
 * Names a unit's running session through its host, so a session the host left unnamed is reachable by name as well; the rename is a
 * change of the host, unresolved until it returns.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param issue - The unit's issue.
 * @param effects - The call's effect state.
 * @returns Once the host named it, or found no session to name.
 * @throws When the host cannot be read, before any rename, or the rename fails, which leaves it unresolved.
 */
async function nameSession(port: EnginePort, host: UnitHost, issue: number, effects: SpawnEffects): Promise<void> {
  const own = (await host.list(port, true)).find(workspace => workspace.issue === issue)
  if (!own || await host.state(port, own, 0, true) === 'none') return
  const naming = effects.begin({ kind: 'name', what: `#${issue}'s running agent was being named ${unitAgent(issue)}`, check: `unit_read ${issue}` })
  const isNamed = await host.name(port, own)
  naming(isNamed ? { kind: 'name', clause: `named its running agent ${unitAgent(issue)}` } : undefined)
}

/**
 * Closes a unit's workspace when the host shows no session in it: the only proof, beside a missing ack, that its start failed. Its reads
 * are strict, so a host answer that cannot be read closes nothing; what they show settles the start.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param issue - The unit's issue.
 * @param effects - The call's effect state.
 * @param resolveStart - Settles the call's host start, when one is under way.
 * @param started - The change a session seen running establishes.
 * @returns The clause saying the workspace was closed, empty when a session runs in it or no workspace is open.
 * @throws When the host cannot be read or answers malformed, or the close fails, the start left unresolved.
 */
async function closeIfGone(port: EnginePort, host: UnitHost, issue: number, effects: SpawnEffects, resolveStart: ((effect?: Effect) => void) | undefined,
  started: Effect): Promise<string> {
  const own = (await host.list(port, true)).find(workspace => workspace.issue === issue)
  if (!own) {
    resolveStart?.()
    return ''
  }
  if (await host.state(port, own, 0, true) !== 'none') {
    resolveStart?.(started)
    return ''
  }
  const closing = effects.begin({ kind: 'workspace', what: `#${issue}'s workspace ${own.workspaceId} was being closed`, check: '`herdr workspace list`' })
  await host.close(port, own)
  closing({ kind: 'workspace', clause: `closed its workspace ${own.workspaceId}` })
  resolveStart?.()
  return `, and no session runs in its workspace, so its workspace was closed: spawn it again to start it afresh`
}

/**
 * Tells whether Claude Code saved a session's conversation, wherever it filed it under the projects directory.
 * @param port - The engine calls.
 * @param session - The session id.
 * @returns Whether its transcript exists, or null when the Claude config directory is unknown.
 */
async function hasConversation(port: EnginePort, session: string): Promise<boolean | null> {
  const directory = await port.readClaudeDir()
  if (!directory) return null
  // why: the projects directory exists only once a session saved something.
  const projects = await port.files.list(`${directory}/projects`).catch(() => [])
  const found = await Promise.all(projects.map(entry => port.files.stat(`${directory}/projects/${entry.name}/${session}.jsonl`).then(() => true, () => false)))
  return found.includes(true)
}

/**
 * Picks and sends the message a starting unit's session takes first: its start assignment until one is acknowledged, an earlier spawn's
 * still unread one included; on a resume, an inform while that assignment is still open, or an assignment for a unit that never got one
 * as mail, naming instead a cancel it still owes. A live session gets nothing more: its conversation is under way.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The unit's issue.
 * @param progress - The unit's spawn record.
 * @param isLive - Whether its session already runs.
 * @param level - The level the session runs on.
 * @param body - The start assignment.
 * @param effects - The call's effect state, in which a send is unresolved until it returns.
 * @returns What was done about the start message, or why it was not sent.
 * @throws When a send throws, which may have delivered it, or the mail a resume depends on cannot be read.
 */
async function stageStartMessage(port: EnginePort, common: string, issue: number, progress: Progress, isLive: boolean, level: UnitLevel,
  body: string, effects: SpawnEffects): Promise<Result<StartDisposition>> {
  const to = unitAddress(issue)
  const session = isLive ? 'its running session' : 'its session'
  const send = async (kind: StartMessage['kind'], text: string): Promise<Result<StartDisposition>> => {
    const sending = effects.begin({ kind: 'message', what: `#${issue}'s ${kind === 'assign' ? 'start assignment' : 'resume message'} was being sent to ${session}`,
      check: `${mailPath(common, to)} and unit_read ${issue}` })
    const sent = await sendMail(port, { kind, to, issue, body: text })
    sending(sent.isOk ? { kind: 'message', clause: `sent #${issue}'s ${describeMessage({ kind, id: sent.value })} to ${session}` } : undefined)
    return sent.isOk ? succeed({ kind: 'sent', message: { kind, id: sent.value } }) : sent
  }
  const recorded = progress.assignId
  if (!progress.isPrompted) {
    const state = recorded ? await readMailState(port, to, recorded) : 'none'
    // why: a second assign would give the unit the same work twice, so a mailbox that cannot be read sends nothing.
    if (state === 'unknown') return succeed({ kind: 'unknown', detail: await describeUnreadMailbox(port, to, `is in it (message ${recorded})`) })
    return recorded && state !== 'none' ? succeed({ kind: 'reused', message: { kind: 'assign', id: recorded } }) : send('assign', body)
  }
  if (isLive) return succeed({ kind: 'live' })
  // why: a unit started before start assignments travelled as mail has none to keep open.
  if (!recorded) return send('assign', body)
  if (progress.assignClosed) return succeed({ kind: 'closed' })
  const answered = await isMailAnswered(port, to, recorded)
  // why: an open assignment gets an inform saying so, which is false of an answered one, so an unread mailbox sends nothing.
  if (answered === null) return succeed({ kind: 'unknown', detail: await describeUnreadMailbox(port, to, `was answered (message ${recorded})`) })
  if (answered) return succeed({ kind: 'closed' })
  const owed = await readOwedMailOrFault(port, common, to)
  // why: an unread mailbox is no proof that the unit owes no cancel, so no inform telling it to go on is sent.
  if (!Array.isArray(owed)) {
    const { failure, check } = describeMailFault(owed)
    throw new Error(`whether #${issue} owes a cancel could not be read (${failure}; ${check}), so no resume message was sent`)
  }
  const cancels = owed.filter(envelope => envelope.kind === 'cancel').map(envelope => envelope.id)
  // why: a resume does not lift a cancel, so a unit that owes one is told to answer it, never to go on with the work it stopped.
  if (cancels.length) return send('inform', `This session was resumed on ${describeLevel(level)}. ${describeOwedCancels(cancels)}`)
  return send('inform', `This session was resumed on ${describeLevel(level)}. Go on with issue #${issue} where you left it: its start assignment `
    + `(message ${recorded}) is still open.`)
}

/**
 * Words a start message withheld because the unit's mailbox could not be read.
 * @param port - The engine calls.
 * @param to - The unit's address.
 * @param question - What could not be told of its start assignment, such as `is in it (message …)`.
 * @returns The clause, naming the mailbox to check.
 */
async function describeUnreadMailbox(port: EnginePort, to: string, question: string): Promise<string> {
  const common = await readCommonDir(port)
  return `its mailbox could not be read, so whether its start assignment ${question} is unknown, and no message was sent; `
    + `check ${common ? mailPath(common, to) : 'its mailbox under the git common directory'} and spawn again`
}

/**
 * Words why a spawn sent no start message.
 * @param disposition - What the spawn did about it, the message reused when it sent none.
 * @returns The clause, such as `its session is live, so no message was sent`.
 */
export function describeUnsent(disposition: StartDisposition): string {
  if (disposition.kind === 'unknown') return disposition.detail
  if (disposition.kind === 'reused') return `its ${describeMessage(disposition.message)} was already in its mailbox, so no new message was sent`
  return disposition.kind === 'closed' ? 'its start assignment is closed, so no message was sent' : 'its session is live, so no message was sent'
}

/**
 * Names a start message in spawn's result.
 * @param message - The message.
 * @returns Such as `start assignment (message …)`.
 */
export function describeMessage(message: StartMessage): string {
  return `${message.kind === 'assign' ? 'start assignment' : 'resume message'} (message ${message.id})`
}

/**
 * Closes the start assignment a unit integrated without replying done to, so a resume never reopens it, and records the closing in its
 * spawn record; the caller holds the spawn lock.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The unit's issue.
 * @returns The closed assignment's id, or null when none was open.
 */
export async function closeOpenAssign(port: EnginePort, common: string, issue: number): Promise<string | null> {
  const progress = await readProgressFile(port, common, issue, true)
  const id = progress.assignId
  // why: an assignment whose answer cannot be read is not recorded as closed without a done.
  if (!id || progress.assignClosed || await isMailAnswered(port, unitAddress(issue), id) !== false) return null
  await writeProgress(port, common, issue, { ...progress, assignClosed: 'integrated without done' })
  return id
}

/**
 * Finds another session that runs and has declared an issue, so no second unit for it starts beside that session.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @returns The session id, or null when only the issue's own unit session, a session a handoff superseded that shares its process, or none, declares it.
 */
export async function findDeclaringSession(port: EnginePort, issue: number): Promise<string | null> {
  const common = await readCommonDir(port)
  const progress = common ? await readProgressFile(port, common, issue, false) : null
  const own = common && progress ? await resolveSpawnedSession(common, issue, progress) : null
  for (const { session } of await readSessionMirrors(port)) {
    // why: a session a handoff superseded still declares the unit, and is the unit's own only while its process is the one the unit went on in.
    if (own && progress?.predecessors?.includes(session.sessionId) && await isSameProcess(port, session.sessionId, own)) continue
    if (session.sessionId !== own && session.unit?.issues.includes(issue) && await readSessionLiveness(port, session.sessionId) === 'live') return session.sessionId
  }
  return null
}

/**
 * Names the session spawn started for an issue's unit, which keeps its id across a resume.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @param strict - Whether an unreadable spawn record throws.
 * @returns The session id, or null when spawn never named a session for the issue or retired it.
 */
export async function readSpawnedSession(port: EnginePort, issue: number, strict: boolean): Promise<string | null> {
  const common = await readCommonDir(port)
  if (!common) return null
  return resolveSpawnedSession(common, issue, await readProgressFile(port, common, issue, strict))
}

/**
 * Names the session a spawn record holds for its unit, the one source of a unit's session identity.
 * @param common - The git common directory.
 * @param issue - The issue.
 * @param progress - The issue's spawn record.
 * @returns The recorded session id; for a started record that has none, the derived one; else null.
 */
export async function resolveSpawnedSession(common: string, issue: number, progress: Progress): Promise<string | null> {
  // why: the record names the session before it starts, and a start the host reported failed may still run as that session.
  if (progress.sessionId) return progress.sessionId
  // why: a record started before spawn kept the session id has none, and its session is the one the derivation gives.
  return progress.isStarted ? deriveSessionId(common, issue) : null
}

/**
 * Says why an issue another session declares gets no unit.
 * @param issue - The issue.
 * @param session - The declaring session.
 * @returns The refusal.
 */
export function describeDeclaring(issue: number, session: string): string {
  return `#${issue} is declared by session ${session}, which still runs: no unit starts for it until that session's declaration is removed`
}

/**
 * Describes how a resumed unit stands: how far its branch is behind its parent's current tip and whether its worktree holds
 * uncommitted changes, so the coordinator decides up front instead of finding out at merge_child.
 * @param port - The engine calls.
 * @param branch - The unit branch.
 * @returns The clauses to append, empty when the branch holds its parent's tip and its worktree is clean.
 */
async function describeStanding(port: EnginePort, branch: string): Promise<string> {
  const git = await readGit(port)
  const parent = git ? await readParentBranch(port.processes, branch, git.base) : null
  const behind = parent ? await readGitOutput(port.processes, ['rev-list', '--count', `${branch}..${parent}`]) : null
  const root = await findWorktreeRoot(port.processes, branch)
  const status = root ? await readWorktreeStatus(port.processes, root) : null
  return `${behind && behind !== '0' ? `; ${branch} is ${behind} commit(s) behind ${parent}'s tip` : ''}${status ? `; ${root} has uncommitted changes` : ''}`
}

/**
 * Reads what spawn's cap sees for plan, from this session's host: a snapshot, not a reserved slot, since a spawn counts again under its lock.
 * @param port - The engine calls.
 * @returns The capacity, or why the host cannot be read.
 */
export async function readPlanCapacity(port: EnginePort): Promise<Result<Capacity>> {
  const host = await readUnitHost(port)
  return host ? readCapacity(port, host) : fail(outsideHerdr)
}

/**
 * Lists the spawned workspaces and counts those holding a slot, strictly: a failed or malformed host answer or an unreadable repository
 * leaves the listing or the count unknown, never empty. An issue whose own workspace is open needs no count, since spawn reuses it.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param issue - The issue spawn starts, if any.
 * @returns The capacity, or why the workspaces cannot be listed.
 */
async function readCapacity(port: EnginePort, host: UnitHost, issue?: number): Promise<Result<Capacity>> {
  const hint = '; check with `herdr workspace list`'
  const listed = await host.list(port, true).then(succeed, (error: unknown) => fail(`${formatErrorLine(error)}${hint}`))
  if (!listed.isOk) return listed
  if (listed.value.some(workspace => workspace.issue === issue)) return succeed({ workspaces: listed.value, running: succeed([]) })
  const running = await filterRunning(port, host, listed.value).then(succeed, (error: unknown) => fail(`${formatErrorLine(error)}${hint}`))
  return succeed({ workspaces: listed.value, running })
}

/**
 * Judges whether spawn's cap lets an issue's unit start now: its own open workspace is reused outside the cap; otherwise the cap must
 * have a free slot, and a listing or count that could not be made leaves it unknown.
 * @param capacity - What the host showed, or why it could not be read.
 * @param issue - The issue.
 * @returns The slot verdict.
 */
export function judgeSlot(capacity: Result<Capacity>, issue: number): Slot {
  if (!capacity.isOk) return { kind: 'unknown', reason: capacity.error }
  const workspace = capacity.value.workspaces.find(each => each.issue === issue)
  if (workspace) return { kind: 'reuse', workspace }
  const { running } = capacity.value
  if (!running.isOk) return { kind: 'unknown', reason: running.error }
  return { kind: running.value.length >= spawnConfig.limit ? 'full' : 'free', running: running.value, limit: spawnConfig.limit }
}

/**
 * Reads the base an issue's spawn record holds.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @returns The recorded base, or null when spawn never started a unit for the issue.
 */
export async function readRecordedBase(port: EnginePort, issue: number): Promise<RecordedBase | null> {
  const common = await readCommonDir(port)
  if (!common) return { kind: 'unknown', reason: 'this session is not in a git repository' }
  try {
    const progress = await readProgressFile(port, common, issue, true)
    if (!progress.isStarted) return null
    return progress.base ? { kind: 'cut', base: progress.base } : { kind: 'none' }
  } catch (error) {
    return { kind: 'unknown', reason: `its spawn record cannot be read: ${formatErrorLine(error)}` }
  }
}

/**
 * Words the branch a unit was cut from, as its spawn record holds it; a missing or unreadable base points at the branch's reflog,
 * whose first entry names it until it expires.
 * @param recorded - The recorded base.
 * @param branch - The unit branch, if known.
 * @returns The phrase.
 */
export function describeBase(recorded: RecordedBase, branch: string | undefined): string {
  if (recorded.kind === 'cut') return `cut from ${recorded.base}`
  const check = `check with \`git reflog show ${branch ?? '<unit branch>'} | tail -1\` (the entry may have expired)`
  return recorded.kind === 'none' ? `base not recorded: ${check}` : `base unknown (${recorded.reason}): ${check}`
}

/**
 * Keeps the workspaces that hold a machine slot: a live session whose unit is still working toward its result.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param workspaces - The spawned workspaces.
 * @returns The workspaces the cap counts.
 * @throws When the host fails or answers malformed, the branches cannot be listed, or the repository state is unreadable.
 */
async function filterRunning(port: EnginePort, host: UnitHost, workspaces: UnitWorkspace[]): Promise<UnitWorkspace[]> {
  const base = await readDefaultBase(port)
  if (!base) throw new Error('the repository state is unreadable')
  const mirrors = await readSessionMirrors(port)
  const counted = await Promise.all(workspaces.map(async workspace => await host.state(port, workspace, 0, true) !== 'none'
    && !['finished', 'integrated'].includes(await readUnitState(port, workspace.issue, base, mirrors))))
  return workspaces.filter((_, index) => counted[index])
}

/**
 * Creates the unit branch of a ready-for-agent issue, `<type>/<n>-<slug>`, typed by the title's Conventional Commit prefix (`<n>-<slug>` without one),
 * create-only, from the default branch or from its open dependency's branch.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param effects - The call's effect state: the placement record, then the cut that takes its place.
 * @returns The branch with the base it was cut from, the base absent when another spawn created it first; or what it waits for.
 * @throws When a write's result is not established, its change left unresolved.
 */
async function createUnitBranch(port: EnginePort, issue: number, effects: SpawnEffects): Promise<Step<CreatedBranch>> {
  const start = await readIssueStart(port, issue)
  if (!start.isOk) return failed(start.error)
  const { title, base } = start.value
  if (!base.isReady) return failed(base.reason)
  const sha = await readGitOutput(port.processes, ['rev-parse', '--verify', '--quiet', base.ref])
  if (!sha) return failed(`cannot resolve ${base.ref}`)
  const type = title.match(conventionalPrefix)?.[1]?.toLowerCase()
  const branch = `${type ? `${type}/` : ''}${issue}-${slugify(title)}`
  const common = await readCommonDir(port)
  // why: recorded before the ref exists, so a window that sees the branch already finds the record.
  const placing = effects.begin({ kind: 'placement', what: `#${issue}'s placement of ${branch} at ${sha} was being recorded`,
    check: common ? recordsPath(common, 'placed') : 'the placed records' })
  const unplaced = await recordPlaced(port, branch, sha).then(() => null, (error: unknown) => {
    if (!(error instanceof UnwrittenError)) throw error
    return error.message
  })
  placing(unplaced ? undefined : { kind: 'placement', clause: `recorded its placement at ${sha}` })
  if (unplaced) return failed(`#${issue}'s branch ${branch} was not created: its placement at ${sha} could not be recorded (${unplaced})`)
  const creating = effects.begin({ kind: 'cut', what: `#${issue}'s branch ${branch} was being created`, check: `\`git rev-parse --verify ${branch}\`` })
  // why: the unit's declaration reads its parent from this first reflog entry; without it a child counts the parent's commits as its own.
  const created = await runGit(port.processes, ['update-ref', '-m', `branch: Created from ${base.parent}`, `refs/heads/${branch}`, sha, ''])
  creating()
  if (created.exitCode === 0) {
    const reflog = `\`git reflog show ${branch} | tail -1\``
    effects.supersede('placement', { kind: 'cut', clause: `created #${issue}'s branch ${branch} from ${base.parent} and keeps it`, check: reflog,
      next: `check it with ${reflog}, then spawn again once the cause is fixed` })
    return succeed({ branch, base: base.parent })
  }
  // why: another spawn created it first, so the base this one chose is not proven to be the branch's.
  const raced = await findUnitBranch(port, issue)
  if (raced) return raced.isOk ? succeed({ branch: raced.value }) : failed(raced.error)
  const said = created.stderr.trim().split(/\r?\n/)[0] || `git exited ${created.exitCode}`
  return failed(`#${issue}'s branch ${branch} could not be created (${said})`, { next: 'spawn again once the cause is fixed' })
}

/**
 * Holds the repository's spawn lock, a host lock held for exactly as long as one piece of work runs, so it dies with its holder.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param work - What runs under the lock.
 * @returns What the work returns, or the failure to take the lock in time.
 */
async function holdLock<R extends Result<unknown>>(port: EnginePort, common: string, work: (held: HeldLock) => Promise<R>): Promise<R | Result<never>> {
  const held = await withHostLock(port, hostLockPath(common, 'spawn'), await port.readSessionId(), async lock => {
    sessionMemory.spawnLockLost = lock.lost
    sessionMemory.spawnLockHeld = lock
    try {
      const cleared = await clearStartMarkers(port, common)
      if (!cleared.isOk) {
        return fail(`the spawn lock was taken, but a start marker an earlier spawn left could not be removed (${cleared.error}), so nothing was done: `
          + `check ${recordsPath(common, 'spawn')}`)
      }
      return await work(lock)
    } catch (error) { return fail(formatErrorLine(error)) } finally {
      sessionMemory.spawnLockLost = null
      sessionMemory.spawnLockHeld = null
    }
  }, { deadline: await port.now() + lockWaitMs, legacy: { dir: recordsPath(common, 'spawn', 'lock'), staleMs: staleLockMs }, renames: true })
  if (held.kind === 'done') return held.value
  if (held.kind === 'failed') return fail(`the spawn lock could not be taken: ${held.error}`)
  return fail('another spawn holds the lock; retry once it ends')
}

/**
 * Checks a condition until it holds or the time runs out, pausing in a host `sleep`: a process call in flight stops the hook's budget
 * clock, which a `$.clock` wait runs down, so a wait as long as the assignment's deadline outlasts the engine's ten-second hook budget.
 * @param port - The engine calls.
 * @param timeoutMs - How long it is checked.
 * @param intervalMs - The pause between two checks.
 * @param check - The condition.
 * @returns Whether it held before the time ran out.
 */
export async function pollUntil(port: EnginePort, timeoutMs: number, intervalMs: number, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = await port.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (await port.now() > deadline) return false
    await executeProcess(port.processes, ['sleep', String(intervalMs / 1000)])
  }
}

/**
 * Names an issue's spawn progress record.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @returns The file path.
 */
export function progressPath(common: string, issue: number): string {
  return recordsPath(common, 'spawn', `${issue}.json`)
}

/**
 * Reads an issue's spawn progress record.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @param strict - Whether an unreadable record throws; else it reads as a unit never started.
 * @returns The progress.
 */
export async function readProgressFile(port: EnginePort, common: string, issue: number, strict: boolean): Promise<Progress> {
  return readProgress(await readJsonUnlessStrict(port.files, progressPath(common, issue), strict, undefined))
}

/**
 * Replaces an issue's spawn progress record.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @param progress - The whole record.
 * @param fence - The held spawn lock, whose rename lands the record only while the lock is still held; the lock this process holds now
 * by default, so every write under the spawn lock is fenced, and a direct rename only outside it.
 * @returns Once the record is written.
 */
export function writeProgress(port: EnginePort, common: string, issue: number, progress: Progress, fence?: HeldLock): Promise<void> {
  return atomicReplace(port, progressPath(common, issue), JSON.stringify(progress), undefined, fence ?? sessionMemory.spawnLockHeld ?? undefined)
}

/**
 * Reads a unit's progress record, a missing or foreign one standing for a unit never started.
 * @param value - The parsed record.
 * @returns The progress.
 */
function readProgress(value: unknown): Progress {
  const text = (key: string): Record<string, string> => isRecord(value) && typeof value[key] === 'string' && value[key] ? { [key]: value[key] } : {}
  const effort = isRecord(value) ? parseEffort(value.effort) : undefined
  return { isStarted: isRecord(value) && value.isStarted === true, isPrompted: isRecord(value) && value.isPrompted === true,
    ...text('assignId'), ...text('assignClosed'), ...text('mode'), ...text('model'), ...(effort ? { effort } : {}),
    ...text('reason'), ...text('escalation'), ...text('escalationFailure'), ...text('escalationUndelivered'), ...text('sessionId'), ...text('startedAt'), ...text('base'),
    ...(isRecord(value) && value.isClosing === true ? { isClosing: true } : {}),
    ...(isRecord(value) && Array.isArray(value.predecessors) && value.predecessors.length && value.predecessors.every(isNonEmptyString)
      ? { predecessors: value.predecessors as string[] } : {}) }
}

/**
 * Reads an effort a coordinator may give a unit.
 * @param value - The effort as given or recorded.
 * @returns The effort, or undefined when it is not one of efforts.
 */
export function parseEffort(value: unknown): Effort | undefined {
  return efforts.find(each => each === value)
}

/**
 * Keeps only a level's own fields, so a record or a call never carries more into the start command.
 * @param level - The level, as recorded or given.
 * @returns The model, effort and reason that are set.
 */
function pickLevel(level: UnitLevel): UnitLevel {
  return { ...level.model ? { model: level.model } : {}, ...level.effort ? { effort: level.effort } : {}, ...level.reason ? { reason: level.reason } : {} }
}

/**
 * Turns a level into the claude flags that start a session on it.
 * @param level - The level.
 * @returns `--model` and `--effort` for what is set; none for the user's defaults.
 */
function levelFlags(level: UnitLevel): string[] {
  return [...level.model ? ['--model', level.model] : [], ...level.effort ? ['--effort', level.effort] : []]
}

/**
 * Words the level a unit runs on, with its reason.
 * @param level - The level.
 * @returns Such as `model haiku, effort low (a typo fix)`; the user's defaults read as such.
 */
export function describeLevel(level: UnitLevel): string {
  const model = level.model ? `model ${level.model}` : 'default model'
  const effort = level.effort ? `effort ${level.effort}` : 'default effort'
  return `${model}, ${effort}${level.reason ? ` (${level.reason})` : ''}`
}

/**
 * Tells whether the claude CLI accepts a model name, by one print turn that loads no plugin, MCP server or hook.
 * @param port - The engine calls.
 * @param model - The model name or alias.
 * @returns Nothing, or why the model is refused.
 */
async function probeModel(port: EnginePort, model: string): Promise<Result<undefined>> {
  const run = await runProcess(port.processes, ['claude', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence',
    '--model', model, '--max-turns', '1', '--output-format', 'json', '-p', 'Reply with OK.'], probeTimeoutMs, { cwd: '/' })
  if (!run.isOk) return fail(`the model ${model} could not be checked, so nothing is started: ${run.error}`)
  const reply = unwrapOr(parseJson(run.value.stdout), undefined)
  if (run.value.exitCode === 0 && isRecord(reply) && reply.is_error === false) return succeed(undefined)
  const said = isRecord(reply) && typeof reply.result === 'string' ? reply.result : run.value.stderr.trim() || `exit ${run.value.exitCode}`
  return fail(`the claude CLI does not run model ${model}, so nothing is started: ${said}`)
}

/**
 * Picks the permission mode a unit starts in from the coordinator's.
 * @param mode - The coordinator's mode, if the engine reported one.
 * @returns The same mode when a unit may run in it, else default.
 */
function inheritMode(mode: string | null | undefined): string {
  return mode && inheritedModes.includes(mode) ? mode : 'default'
}

/**
 * Reads how spawn started a unit of these issues, from the first started record.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @returns The recorded mode, level and base, or undefined when spawn never started one.
 */
export async function readSpawnStart(port: EnginePort, issues: number[]): Promise<SpawnStart | undefined> {
  for (const issue of issues) {
    const progress = await readSpawnProgress(port, issue)
    if (progress?.isStarted) return { ...progress.mode ? { mode: progress.mode } : {}, level: pickLevel(progress), ...progress.base ? { base: progress.base } : {} }
  }
  return undefined
}

/**
 * Reads an issue's spawn progress record.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @returns The progress, or null outside a repository or when the record is unreadable.
 */
export async function readSpawnProgress(port: EnginePort, issue: number): Promise<Progress | null> {
  const common = await readCommonDir(port)
  return common ? readProgressFile(port, common, issue, false) : null
}

/**
 * Tells whether a level is the escalation target already: the user's default model with effort high, or the user's defaults untouched,
 * which the mod never overrides.
 * @param level - The unit's level.
 * @returns Whether an escalation would not raise it.
 */
export function isTopLevel(level: UnitLevel): boolean {
  return !level.model && level.effort !== 'low' && level.effort !== 'medium'
}

/**
 * Tells whether a unit's session is idle, waiting briefly for a turn that is ending.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @param waitMs - How long a working session is given to go idle.
 * @returns Whether its host reports it idle within that time; false without a host or a running session.
 */
export async function isUnitIdle(port: EnginePort, issue: number, waitMs: number): Promise<boolean> {
  const host = await readUnitHost(port)
  if (!host) return false
  return await host.state(port, (await host.list(port)).find(workspace => workspace.issue === issue), waitMs) === 'idle'
}

/**
 * Raises an idle unit to the user's default model with effort high: closes its session through its host, records the new level, and
 * resumes the same conversation on it, under the spawn lock, passing the model the engine reports, or the account's default when it
 * reports none, since a resumed session keeps the model it ran on. A unit that works, or already runs at that level, is left as it is.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @param signal - What triggered the escalation, recorded as the level's reason.
 * @returns The escalation under way, its resume failed included, and the model passed, null for the account's default; null when the unit
 * already runs at the top level, as when another sweep raised it first; a stop or an unknown when its session's close did not end; or
 * why it was not escalated, when nothing changed.
 */
export async function escalateUnit(port: EnginePort, issue: number, signal: string): Promise<Result<Escalation | null>> {
  const host = await readUnitHost(port)
  if (!host) return fail(outsideHerdr)
  return withSpawnLock(port, async (common, root) => {
    const progress = await readProgressFile(port, common, issue, true)
    if (!progress.isStarted) return fail(`#${issue} has no unit spawn started`)
    if (isTopLevel(progress)) return succeed(null)
    const own = (await host.list(port)).find(workspace => workspace.issue === issue)
    const state = await host.state(port, own, busyWaitMs)
    if (state === 'working') return fail(`#${issue}'s unit works, so it is not escalated now`)
    const resumed = await port.readModel()
    const isClosed = !!own && state === 'idle'
    if (own && isClosed) {
      const closed = await closeForEscalation(port, host, issue, own)
      if (closed) return closed
    }
    const { model, escalation, escalationFailure, ...rest } = progress
    const written = await writeProgress(port, common, issue, { ...rest, effort: 'high', reason: `escalated: ${signal}` }).then(() => null, (error: unknown) => error)
    // why: a rename the lock holder never answered may have landed, so the level is neither recorded nor left as it was.
    if (written instanceof UnansweredRenameError) {
      return unknown(`#${issue}'s escalation ${isClosed ? 'closed its session, and ' : ''}whether its escalated level was recorded is unknown (${written.message})`,
        `the effort and reason of ${progressPath(common, issue)}, then run escalate_unit for #${issue} again`)
    }
    const recorded: Result<undefined> = written === null ? succeed(undefined) : fail(formatErrorLine(written))
    const effects = createSpawnEffects(issue)
    // why: the escalation's notice names the close and the level write itself; recorded here, a resume that fails after them is never a refusal.
    if (isClosed) effects.establish({ kind: 'escalation', clause: `closed #${issue}'s session for its escalation`, isNamed: true })
    if (recorded.isOk) effects.establish({ kind: 'level', clause: 'recorded its escalated level', isNamed: true })
    const started = recorded.isOk ? await spawnLocked(port, host, common, root, issue, '', {}, createStartMarker(port, common, issue, effects), effects,
      resumed ?? 'default') : recorded
    // why: the level may be raised and the session closed by now, so a failed resume is part of the escalation, never its absence; only a host start still unresolved is looked at again.
    const seen: SessionSeen = started.isOk ? { kind: 'runs' } : effects.isPending('start') ? await seeSession(port, host, issue)
      : effects.has('start') ? { kind: 'runs' } : effects.has('workspace') || effects.has('opened') ? { kind: 'not-running' } : { kind: isClosed ? 'closed' : 'not-running' }
    return succeed({ model: resumed, isClosed, isLevelRecorded: recorded.isOk, resumed: started, seen })
  })
}

/**
 * Closes a unit's idle session for its escalation and waits for it to end.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param issue - The issue.
 * @param own - The unit's workspace.
 * @returns Null once the session ended; a stop naming the session still seen when it outlived the wait; an unknown when the close or
 * a look at the session failed, since the close may have gone through.
 */
async function closeForEscalation(port: EnginePort, host: UnitHost, issue: number, own: UnitWorkspace): Promise<Result<never> | null> {
  const closed = await settle((async () => {
    await host.close(port, own)
    // why: a lenient read shows a malformed pane list as no session, a false close; a strict one throws, so the close is unknown instead.
    return pollUntil(port, exitWaitMs, 500, async () => await host.state(port, own, 0, true) === 'none')
  })())
  const check = `unit_read ${issue}, then run escalate_unit for #${issue} again`
  if (!closed.isOk) return unknown(`#${issue}'s session was being closed for its escalation, and its level was not raised, when ${closed.error}`, check)
  if (closed.value) return null
  return stop(`#${issue}'s host was asked to close its session for the escalation, but a session still ran in its workspace ${exitWaitMs / 1000} s later, `
    + `so its level was not raised; check ${check}`)
}

/**
 * Looks at a unit's session again after its escalation's resume failed past its host start, with reads that fail rather than guess.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param issue - The issue.
 * @returns What runs in its workspace, or why it could not be read.
 */
async function seeSession(port: EnginePort, host: UnitHost, issue: number): Promise<SessionSeen> {
  const seen = await settle((async () => {
    // why: strict reads throw on a malformed or failed host answer, which a lenient read would show as no session, a false "not running".
    const own = (await host.list(port, true)).find(workspace => workspace.issue === issue)
    return own ? await host.state(port, own, 0, true) : 'none'
  })())
  if (!seen.isOk) return { kind: 'unknown', reason: seen.error }
  return { kind: seen.value === 'none' ? 'not-running' : 'runs' }
}

/**
 * Turns an issue title into a branch slug, without its Conventional Commit prefix.
 * @param title - The issue title.
 * @returns Lowercase words joined by hyphens, at most 40 characters.
 */
function slugify(title: string): string {
  const words = title.replace(conventionalPrefix, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const slug = words.reduce((kept, word) => !kept ? word : `${kept}-${word}`.length <= 40 ? `${kept}-${word}` : kept, '')
  return slug.slice(0, 40) || 'unit'
}

/**
 * Derives the unit's session id as a UUIDv5 of the repository and the issue, so a restart resumes the same session.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @returns The session id.
 */
export async function deriveSessionId(common: string, issue: number): Promise<string> {
  const name = new TextEncoder().encode(`${common}#${issue}`)
  const bytes = new Uint8Array(16 + name.length)
  bytes.set(namespace.match(/../g)?.map(pair => parseInt(pair, 16)) ?? [])
  bytes.set(name, 16)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes)).slice(0, 16)
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80
  const hex = [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
