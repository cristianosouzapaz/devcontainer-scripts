import { expect } from 'claude-code/testing'

import { createExplorerWorld, enumerate, exhaustiveAlphabet, explore, explorerStats, isFollowUpClass, runSchedule } from '../support/explorer'
import type { Mutation, Step, Violation } from '../support/explorer'
import { test } from '../support/kit'
import { soakPerSeed } from '../support/soak'

/** How deep the bounded exhaustive exploration goes: every schedule of three events that can each act in the normal suite, of four in a soak run. */
const exhaustiveDepth = soakPerSeed > 0 ? 4 : 3

/**
 * Every blocker the reviews of the mod's start delivery reported, and every schedule the explorer found breaking an invariant since, shrunk,
 * by review and number: each must hold every invariant. The r733h review is the one of 2aa7049c, the r733j review the one of 4fcef873,
 * the r733k review the one of 97c75fda; the found ones are the explorer's own. r733h-10, a rename whose answer was lost, is the explorer's
 * `lose:rename`, which the random exploration draws; r733k-2b holds only where reads are fresh, as the engine's one moment per dispatch
 * rules it out; r733k-7 is the migration of unknown outcomes, released now by evidence alone.
 */
const blockers: readonly { name: string; schedule: readonly Step[] }[] = [
  { name: 'r733h-1 a replaced load answers its start\'s submit after the reload', schedule: ['turn', 'keep', 'end', 'reload', 'drop'] },
  { name: 'r733h-2 a late end of an earlier turn arrives after a newer turn\'s failed start', schedule: ['turn', 'keep', 'overlap-failed', 'tick'] },
  { name: 'r733h-3 a failed turn start is painted', schedule: ['turn-failed', 'paint', 'keep', 'tick'] },
  { name: 'r733h-4 a sent message whose later state read fails', schedule: ['turn', 'send', 'sent', 'read-on', 'stop', 'read-off'] },
  { name: 'r733h-5 a sent message whose write failed before a reload', schedule: ['turn', 'write-on', 'send', 'sent', 'write-off', 'reload', 'stop'] },
  { name: 'r733h-6 an idle earlier record unreadable through a reload', schedule: ['upgrade', 'end', 'activity-on', 'restart', 'keep', 'activity-off', 'tick'] },
  { name: 'r733h-7 a late submit success before its unknown settlement lands', schedule: ['keep', 'time', 'write-once', 'ok', 'tick'] },
  { name: 'r733h-8 a delivered wake whose claim cannot be cleared', schedule: ['wake', 'write-on', 'ok', 'write-off', 'tick'] },
  { name: 'r733h-9 a wake submit that never settles', schedule: ['wake', 'time', 'tick', 'paint'] },
  { name: 'r733h-11 a Stop is compacted while a start waits', schedule: ['turn', 'keep', 'stop', 'compact', 'end', 'tick'] },
  { name: 'r733h-12 a tool call, a failed write and an interrupt after a Stop', schedule: ['turn', 'keep', 'stop', 'tool', 'write-once', 'interrupt', 'tick'] },
  { name: 'r733j-1 a delayed end erases a newer running turn, then a reload', schedule: ['turn', 'keep', 'overlap-failed', 'reload', 'tick'] },
  { name: 'r733j-2 a turn starts while a claim waits on its write', schedule: ['stall', 'keep', 'turn-failed', 'release', 'tick'] },
  { name: 'r733j-3 a failed first read at an upgrade reload during a turn', schedule: ['read-on', 'upgrade', 'keep', 'read-off', 'tick', 'end', 'tick'] },
  { name: 'r733j-4 a process that cannot stamp itself at an upgrade reload during a turn', schedule: ['own-on', 'upgrade', 'keep', 'tick', 'own-off', 'tick', 'end', 'tick'] },
  { name: 'r733j-5 a restart whose predecessor host record cannot be read', schedule: ['turn', 'host-on', 'restart', 'keep', 'tick', 'host-off', 'tick'] },
  { name: 'r733j-6 a send after a failed turn start', schedule: ['turn-failed', 'send', 'sent', 'stop', 'tick'] },
  { name: 'r733j-7 a tool call held on a stalled write while the turn is interrupted', schedule: ['turn', 'keep', 'stop', 'stall', 'tool', 'interrupt', 'release', 'tick'] },
  { name: 'r733j-8 a replaced load\'s submit confirms after the new load swept', schedule: ['keep', 'reload', 'tick', 'ok', 'tick'] },
  { name: 'r733j-9 a late start answer whose receipt write fails once', schedule: ['keep', 'time', 'write-once', 'ok', 'tick'] },
  { name: 'r733j-10 a wake whose submit times out and whose receipt write fails', schedule: ['wake', 'time', 'write-once', 'ok', 'tick'] },
  { name: 'r733j-11 a replaced load\'s wake answers after the reload', schedule: ['wake', 'reload', 'ok', 'tick'] },
  { name: 'r733k-1 a tick runs before the session start adopts the state of an upgrade during a turn', schedule: ['hold:session-read', 'upgrade', 'tick', 'keep', 'tick'] },
  { name: 'r733k-2a a turn start written after its own end', schedule: ['type', 'hold:state-write', 'begin', 'interrupt', 'resume', 'keep', 'tick'] },
  { name: 'r733k-2b a turn start published after its own end, where reads are fresh', schedule: ['fresh', 'hold:lock', 'turn', 'end', 'resume', 'keep', 'tick'] },
  { name: 'r733k-3 an earlier turn\'s send finishes after a later turn\'s send whose fact did not land', schedule: ['turn', 'send', 'interrupt', 'turn', 'send', 'fail:state-write', 'sent', 'sent', 'stop'] },
  { name: 'r733k-4 a replaced load\'s receipt retry is cancelled', schedule: ['keep', 'time', 'fail:state-write', 'drop', 'reload', 'tick'] },
  { name: 'r733k-5a a replaced approval follower resumes over a newer pending wake', schedule: ['hold:records', 'wake', 'reload', 'wake', 'resume', 'tick'] },
  { name: 'r733k-5b a replaced command keeps a start after the reload', schedule: ['hold:state-write', 'keep', 'reload', 'resume', 'tick'] },
  { name: 'r733k-6 a replaced load resumes after the recorded load stopped ticking', schedule: ['hold:state-read', 'tick', 'reload', 'time', 'time', 'time', 'resume', 'tick'] },
  { name: 'r733k-7 unknown outcomes migrated from the shape before attempts', schedule: ['migrate', 'tick'] },
  { name: 'r733k-8a a doorbell while the start first in line cannot be composed', schedule: ['step', 'fail:session-read', 'paint', 'doorbell'] },
  { name: 'r733k-8b a turn that sends nothing while an unknown outcome holds', schedule: ['keep', 'time', 'fail', 'turn', 'stop'] },
  { name: 'r733k-9 a claim the reload interrupted before its submit', schedule: ['keep', 'park:state-write', 'reload', 'paint'] },
  { name: 'r733k-10 a step start whose unit concluded before its turn came', schedule: ['turn', 'step', 'conclude', 'end', 'tick'] },
  { name: 'r733k-11 a turn change seeds the state before adoption', schedule: ['hold:session-read', 'restart', 'turn', 'resume', 'tick'] },
  { name: 'r733k-12 a load write fails, then a start is kept', schedule: ['fail:state-write', 'tick', 'paint', 'keep', 'time'] },
  { name: 'r733l-1a a start a replaced load heard and never recorded, then a delivery after the reload', schedule: ['type', 'hold:state-write', 'begin', 'reload', 'keep', 'time', 'tick', 'tick'] },
  { name: 'r733l-1b an end a replaced load heard and never recorded strands the starts behind it', schedule: ['turn', 'keep', 'hold:state-write', 'end', 'reload', 'cut', 'tick'] },
  { name: 'r733l-2 a failed end forgotten before its delayed start lands', schedule: ['type', 'hold:state-write', 'begin', 'fail:state-write', 'interrupt', 'turn', 'resume', 'keep', 'end', 'tick'] },
  { name: 'r733l-3 an established drop whose receipt retry a reload cancels', schedule: ['keep', 'time', 'fail:state-write', 'drop', 'reload', 'tick'] },
  { name: 'r733l-4 a keep that landed and whose answer was lost', schedule: ['lose:state-write', 'keep'] },
  { name: 'r733l-5 a notice acknowledged while the pane shows Run log', schedule: ['open', 'runlog', 'migrate', 'tick', 'tick'] },
  { name: 'r733l-6 an overflow notice grows after a render drew it', schedule: ['open', 'migrate', 'migrate', 'migrate', 'migrate', 'tick', 'render', 'migrate', 'tick', 'tick'] },
  { name: 'r733l-8 a replaced load\'s paint lands over the current load\'s view', schedule: ['turn', 'hold:paint', 'end', 'reload', 'turn', 'resume', 'open', 'render'] },
  { name: 'r733l-9 a send completes while a delegated Stop waits on its reads', schedule: ['turn', 'send', 'hold:records', 'stop', ...Array.from({ length: 8 }, () => ['hold:records', 'resume'] as const).flat(), 'sent', 'resume'] },
  { name: 'r733l-10 a process state of an unknown shape, then a turn', schedule: ['foreign', 'open', 'render', 'turn'] },
  { name: 'r733m-S1 a doorbell a tick after a prompt entered whose turn has not started', schedule: ['type', 'tick', 'doorbell'] },
  { name: 'r733m-1 an outcome established after a render acknowledged the unknown notice', schedule: ['keep', 'time', 'tick', 'turn', 'end', 'open', 'render', 'ok', 'tick', 'tick'] },
  { name: 'r733m-2 an answer that comes after its unknown notice was drawn and dismissed', schedule: ['keep', 'time', 'tick', 'turn', 'end', 'open', 'render', 'tick', 'ok', 'tick'] },
  { name: 'r733m-4 a turn end whose clock read fails before its write', schedule: ['turn', 'fail:clock', 'end', 'keep', 'tick'] },
  { name: 'r733m-5 a reload whose load number cannot be taken once', schedule: ['turn', 'fail:seq', 'reload', 'end', 'open', 'render'] },
  { name: 'r733m-7 a notice the pane drew below its window', schedule: ['open', 'migrate', 'tick', 'render-short', 'tick', 'tick'] },
  { name: 'r733m-8 a reload while a replaced load holds an unrecorded turn start, read by a coordinator', schedule: ['turn', 'end', 'type', 'hold:state-write', 'begin', 'reload', 'tick'] },
  { name: 'r733m-9 a reload hold at rest with the pane closed', schedule: ['turn', 'keep', 'hold:state-write', 'end', 'reload', 'cut', 'close'] },
  { name: 'r733m-10 a load that stood down is told a reload delivers its starts', schedule: ['hold:host', 'upgrade', 'on:state-write', 'reload'] },
  { name: 'found-1 an older load\'s first look comes after a newer load recorded itself', schedule: ['hold:host', 'upgrade', 'reload'] },
  { name: 'found-2 a claim lands and its answer is lost', schedule: ['keep', 'lose:state-write'] },
  { name: 'found-3 a claim whose answer is lost holds a start behind it', schedule: ['keep', 'lose:state-write', 'step'] },
  { name: 'found-4 a turn end seeds the state while the adoption read is held', schedule: ['hold:state-read', 'upgrade', 'interrupt', 'migrate'] },
  { name: 'found-5 a turn end whose state read and write both fail', schedule: ['on:state-read', 'turn', 'end-failed', 'off:state-read', 'reload', 'keep'] },
  { name: 'found-6 a load a late record superseded learns it', schedule: ['hold:state-read', 'keep', 'migrate', 'reload', 'turn'] },
  { name: 'found-7 a start\'s activity publish lands after later turns', schedule: ['hold:activity', 'hold:lock', 'turn', 'overlap-failed', 'park:session-read', 'tick', 'end', 'step'] },
  { name: 'found-8 a replaced load\'s late start over a state seeded from the record', schedule: ['park:state-read', 'park:state-read', 'upgrade', 'overlap-failed', 'end-failed', 'reload', 'keep'] },
  { name: 'found-9 a typed prompt between a claim and its submit', schedule: ['park:state-write', 'doorbell', 'turn'] },
  { name: 'found-10 a typed prompt while a failed submit\'s receipt is written', schedule: ['keep', 'paint', 'hold:state-write', 'fail', 'turn-failed'] },
  { name: 'found-11 an end whose publish failed leaves the record ahead', schedule: ['upgrade', 'overlap-failed', 'lose:lock', 'wake', 'lose:session-read', 'end'] },
  { name: 'found-12 a typed prompt while this load\'s claim waits for its answer', schedule: ['step', 'park:state-write', 'tick', 'keep', 'turn'] },
  { name: 'found-13 a turn change seeds a new process before its adoption', schedule: ['hold:identity', 'turn', 'restart', 'turn', 'step'] },
  { name: 'found-14 a typed prompt whose release cannot be written', schedule: ['keep', 'fail', 'on:state-write', 'turn'] },
  { name: 'found-15 a typed prompt while the state cannot be read', schedule: ['step', 'on:state-read', 'fail', 'on:state-write', 'turn'] },
  { name: 'found-16 more notices than the state keeps', schedule: ['wake', 'migrate', 'migrate', 'migrate', 'migrate', 'tick'] },
  { name: 'found-17 a prompt whose attempt settled before its entry was heard', schedule: ['wake', 'wake', 'keep'] },
  { name: 'found-18 a refusal decided before this load\'s record landed', schedule: ['park:state-read', 'keep', 'migrate', 'park:state-write', 'step'] },
  { name: 'found-19 a typed prompt while a submit is in flight that later turns unknown', schedule: ['hold:state-write', 'hold:host', 'upgrade', 'on:state-write', 'keep', 'wake', 'reload'] },
  { name: 'found-20 a start heard after its own end settles a failed end', schedule: ['upgrade', 'keep', 'end-failed', 'turn', 'hold:session-read', 'migrate', 'fail:lock', 'end-failed', 'lose:activity', 'turn'] },
  { name: 'found-21 this process\'s record outranked by a seed\'s epoch', schedule: ['park:session-read', 'park:session-read', 'upgrade', 'overlap-failed', 'migrate'] },
  { name: 'found-22 a typed prompt whose handler resumes after a submit failed', schedule: ['wake', 'fail:host', 'stall', 'turn', 'keep', 'fail'] },
  { name: 'found-23 a replaced load\'s start lands after its own end reached only the record', schedule: ['stall', 'park:state-read', 'turn-failed', 'end', 'lose:state-read', 'migrate', 'wake'] },
  { name: 'found-24 a view whose dispatch\'s missed write moved its moment past a turn end', schedule: ['turn', 'stall', 'reload', 'end'] },
  { name: 'found-25 an entering prompt whose write lands after its turn ended', schedule: ['stall', 'turn', 'keep', 'end'] },
  { name: 'found-26 a paint whose continuation resumes after a newer load published', schedule: ['park:paint', 'turn', 'reload'] },
  { name: 'r42-S2 a start whose submit failed before the host, handed over by a typed prompt', schedule: ['fail:submit', 'keep', 'keep'] },
  { name: 'r42-S3 a doorbell whose answer was lost, handed over by a typed prompt', schedule: ['lose:submit', 'doorbell', 'tick', 'turn'] },
  { name: 'r42-S3b a start whose answer was lost enters after a typed prompt ended it', schedule: ['lose:submit', 'keep', 'tick', 'turn', 'end'] },
  { name: 'r42-S4 a Stop never comes while its turn\'s send is in flight', schedule: ['turn-failed', 'send', 'stop'] },
  { name: 'r42-S5 a Stop whose answer is parked across a migration', schedule: ['park:state-write', 'stop', 'migrate'] },
  { name: 'r42-A a paint that read the state before a turn start a held lock delayed', schedule: ['hold:lock', 'park:rename', 'tick', 'turn', 'overlap-failed'] },
  { name: 'r42-D a paint that read the state before a turn start, with locks parked', schedule: ['on:state-write', 'park:lock', 'park:lock', 'tick', 'turn'] },
  { name: 'r42-E a paint that read the state before an overlapping turn start landed', schedule: ['turn', 'hold:lock', 'hold:state-read', 'overlap'] },
  { name: 'r42-F a paint that read the state before an end of a turn whose start never landed', schedule: ['turn', 'park:lock', 'overlap-failed', 'interrupt'] },
  { name: 'r42-G a paint after an upgrade that read the state before a turn start', schedule: ['upgrade', 'hold:state-write', 'hold:identity', 'overlap'] },
  { name: 'r42-B a replaced load\'s held number outranks the recorded load, with a read held', schedule: ['hold:seq', 'hold:state-read', 'migrate', 'migrate'] },
  { name: 'r42-C a replaced load\'s held number outranks the recorded load', schedule: ['hold:seq', 'park:seq', 'migrate', 'migrate'] },
  { name: 'r42-S6 a replaced load\'s held number under a state of an unknown shape', schedule: ['foreign', 'hold:seq', 'migrate', 'migrate'] },
  { name: 'r42-H a replaced load\'s held paint across a reload, with no load recorded yet', schedule: ['hold:paint', 'upgrade', 'overlap', 'reload'] },
  { name: 'r42-I held host and identity reads across a reload and a migration', schedule: ['hold:host', 'reload', 'hold:identity', 'paint', 'migrate'] },
  { name: 'r42-J a held clock read and parked records across a reload and a migration', schedule: ['hold:clock', 'park:records', 'reload', 'paint', 'migrate'] },
]

/**
 * The mutation checks: for each invariant, a defect of the kind it targets, injected at the hooks' boundary, and a schedule that reaches
 * it; each schedule holds every invariant without its defect and breaks its invariant with it.
 */
const mutations: readonly { invariant: Violation['invariant']; mutation: Mutation; defect: string; schedule: readonly Step[] }[] = [
  { invariant: 'I1', mutation: 'turn-unwritten', defect: 'a turn start that writes no turn', schedule: ['turn', 'keep', 'tick'] },
  { invariant: 'I2', mutation: 'unknown-retried', defect: 'an unknown outcome read as a drop', schedule: ['keep', 'time', 'tick', 'tick'] },
  { invariant: 'I3', mutation: 'order-reversed', defect: 'the keeping read newest first', schedule: ['turn', 'keep', 'keep', 'end', 'tick'] },
  { invariant: 'I4', mutation: 'notices-dropped', defect: 'every write drops the notices', schedule: ['keep', 'time', 'fail', 'turn'] },
  { invariant: 'I5', mutation: 'hold-row-hidden', defect: 'the pane leaves out the hold row', schedule: ['keep', 'time', 'fail'] },
  { invariant: 'I6', mutation: 'old-load-unfenced', defect: 'a replaced load takes itself for the recorded one', schedule: ['hold:state-write', 'keep', 'reload', 'resume'] },
  { invariant: 'I7', mutation: 'delivery-dropped', defect: 'no deferred delivery runs', schedule: ['keep'] },
  { invariant: 'I4', mutation: 'receipt-lost', defect: 'an established answer reaches no record once its attempt ended', schedule: ['keep', 'time', 'tick', 'turn', 'end', 'open', 'render', 'tick', 'ok', 'tick'] },
  { invariant: 'I5', mutation: 'false-explanation', defect: 'a notice drawn as entered whatever it holds', schedule: ['keep', 'time', 'tick', 'turn', 'end', 'open', 'render'] },
  { invariant: 'I5', mutation: 'offscreen-ack', defect: 'a render acknowledging notices below its window', schedule: ['open', 'migrate', 'tick', 'render-short', 'tick', 'tick'] },
  { invariant: 'I6', mutation: 'view-unfenced', defect: 'a view published whatever load number stands', schedule: ['turn', 'hold:paint', 'end', 'reload', 'turn', 'resume', 'open', 'render'] },
]

// group: Invariant checker
// contract: the checker flags a submit that bypasses the gate into a running turn, with no attempt written before it
test('the checker flags a rogue submit into a running turn', async (_$, on) => {
  const violations = await runSchedule(createExplorerWorld(on), ['turn', 'rogue'])
  expect([...new Set(violations.map(violation => violation.invariant))].sort()).toEqual(['I1', 'I6'])
})

for (const check of mutations) {
  // group: Mutation checks
  // contract: each invariant goes red on the defect it targets, injected at the hooks' boundary, on a schedule that holds every invariant without it
  test(`mutation check: ${check.invariant} goes red on ${check.defect}`, async (_$, on) => {
    expect(await runSchedule(createExplorerWorld(on), check.schedule)).toEqual([])
    const violations = await runSchedule(createExplorerWorld(on), check.schedule, check.mutation)
    expect(violations.map(violation => violation.invariant)).toContain(check.invariant)
  })
}

// group: Soak gate
// contract: the soak gate holds every replay of at most one fault that fired, a suspension across a reload included, and sets apart, reported, only replays where two faults fired, or a fault fired and a call stayed suspended as a load started
test('the soak gate classes the release-blocking schedules in and the follow-up ones out', async (_$, on) => {
  // why: a suspension that ended before the reload never crossed it, so its fault alone keeps the replay in the gate.
  expect(await (async () => { await runSchedule(createExplorerWorld(on), ['hold:state-write', 'keep', 'release', 'fail:host', 'reload']); return isFollowUpClass(explorerStats.lastFaults) })()).toBe(false)
  const followUp: Step[][] = [
    ['fail:registration', 'on:state-write', 'fail:lock', 'turn-failed', 'reload'], ['fail:seq', 'hold:records', 'hold:state-read', 'paint', 'restart', 'reload'],
    ['hold:identity', 'lose:seq', 'migrate', 'migrate'], ['hold:seq', 'migrate', 'lose:seq', 'park:rename', 'resume', 'migrate', 'tick'],
    ['hold:seq', 'wake', 'reload', 'fail:registration', 'migrate'], ['keep', 'lose:submit', 'tick', 'turn-failed'], ['lose:seq', 'hold:clock', 'reload', 'migrate'],
    ['lose:seq', 'hold:clock', 'restart', 'reload'], ['lose:seq', 'hold:host', 'reload', 'migrate'], ['lose:seq', 'park:lock', 'migrate', 'migrate'],
    ['on:state-read', 'hold:seq', 'restart', 'reload'], ['park:lock', 'lose:seq', 'restart', 'migrate'], ['park:paint', 'lose:lock', 'tick', 'migrate'],
    ['park:records', 'lose:seq', 'restart', 'reload'], ['turn-failed', 'lose:clock', 'park:seq', 'reload', 'hold:lock', 'overlap-failed', 'keep', 'migrate'],
    ['type', 'park:rename', 'begin', 'upgrade', 'overlap-failed', 'reload'],
  ]
  const gated: Step[][] = [
    ['fail:submit', 'keep', 'keep'], ['lose:submit', 'doorbell', 'tick', 'turn'], ['turn-failed', 'send', 'stop'], ['park:state-write', 'stop', 'migrate'],
    ['foreign', 'hold:seq', 'migrate', 'migrate'], ['hold:lock', 'park:rename', 'tick', 'turn', 'overlap-failed'], ['hold:seq', 'hold:state-read', 'migrate', 'migrate'],
    ['hold:seq', 'park:seq', 'migrate', 'migrate'], ['on:state-write', 'park:lock', 'park:lock', 'tick', 'turn'], ['turn', 'hold:lock', 'hold:state-read', 'overlap'],
    ['turn', 'park:lock', 'overlap-failed', 'interrupt'], ['upgrade', 'hold:state-write', 'hold:identity', 'overlap'],
  ]
  const classify = async (schedule: Step[]): Promise<boolean> => {
    await runSchedule(createExplorerWorld(on), schedule)
    return isFollowUpClass(explorerStats.lastFaults)
  }
  const outcomes: { schedule: string; isFollowUp: boolean }[] = []
  for (const schedule of [...followUp, ...gated]) outcomes.push({ schedule: schedule.join(','), isFollowUp: await classify(schedule) })
  expect(outcomes).toEqual([...followUp.map(schedule => ({ schedule: schedule.join(','), isFollowUp: true })), ...gated.map(schedule => ({ schedule: schedule.join(','), isFollowUp: false }))])
})

// group: Recorded limits
// contract: the excuse for a load whose held or parked number claim landed after a newer load started covers that load's view rows alone: with a defect injected, every other violation is the same with the excuse or without it, so it hides no submission, claim, queue or receipt
test('the late number claim excuse hides nothing but that load\'s views', async (_$, on) => {
  const late: Step[] = ['hold:seq', 'park:seq', 'migrate', 'migrate']
  const cases: { mutation: Mutation; schedule: Step[] }[] = [
    { mutation: 'unknown-retried', schedule: [...late, 'keep', 'time', 'tick', 'tick'] },
    { mutation: 'order-reversed', schedule: [...late, 'turn', 'keep', 'keep', 'end', 'tick'] }, { mutation: 'notices-dropped', schedule: [...late, 'keep', 'time', 'fail', 'turn'] },
    { mutation: 'receipt-lost', schedule: ['keep', 'time', 'tick', 'turn', 'end', 'open', 'render', 'tick', 'ok', 'hold:seq', 'park:seq', 'migrate', 'migrate', 'tick'] },
  ]
  const isViewRow = (violation: Violation): boolean => /published a view over|the pane shows the view load/.test(violation.detail)
  const describe = (violations: Violation[]): string[] => violations.filter(violation => !isViewRow(violation)).map(violation => `${violation.invariant}: ${violation.detail}`).sort()
  // why: without the excuse the late claim itself breaks a view row, so the excuse is in play in every case below.
  expect((await runSchedule(createExplorerWorld(on), late, null, false)).some(isViewRow)).toBe(true)
  const outcomes: { mutation: Mutation; isRed: boolean; isSame: boolean }[] = []
  for (const each of cases) {
    const excused = await runSchedule(createExplorerWorld(on), each.schedule, each.mutation)
    const strict = await runSchedule(createExplorerWorld(on), each.schedule, each.mutation, false)
    outcomes.push({ mutation: each.mutation, isRed: describe(excused).length > 0, isSame: JSON.stringify(describe(excused)) === JSON.stringify(describe(strict)) })
  }
  expect(outcomes).toEqual(cases.map(each => ({ mutation: each.mutation, isRed: true, isSame: true })))
})

for (const blocker of blockers) {
  // group: Regression schedules of every reported blocker and every finding
  // contract: a schedule that reproduced a reported blocker, or that the explorer found breaking an invariant, now holds every invariant
  test(blocker.name, async (_$, on) => {
    expect(await explore(on, [blocker.schedule], null, false)).toEqual([])
  })
}

for (const [first, second] of enumerate(exhaustiveAlphabet, 2)) {
  // group: Bounded exhaustive exploration
  // contract: every schedule of three events that can each act, four in a soak run, from a session start, holds every invariant
  test(`every schedule of ${exhaustiveDepth} events starting with ${first ?? ''}, ${second ?? ''} holds every invariant`, async (_$, on) => {
    const schedules = enumerate(exhaustiveAlphabet, exhaustiveDepth).filter(schedule => schedule[0] === first && schedule[1] === second)
    expect(await explore(on, schedules, null)).toEqual([])
  })
}

// contract: the exploration reports how many submits went through the host's claim-to-submit interval, which no submit-if-idle closes, as its own count, never as a pass of I1
test('the exploration reports its claim-to-submit exposure', () => {
  // why: the count is reported beside the results, as a measured host limit rather than a pass or a failure.
  const host = globalThis as { console?: { log: (text: string) => void } }
  host.console?.log(`explorer: ${explorerStats.schedules} schedules run, claim-to-submit exposure ${explorerStats.exposure}, follow-up class reds ${explorerStats.followUps}`)
  expect(explorerStats.schedules).toBeGreaterThan(0)
})
