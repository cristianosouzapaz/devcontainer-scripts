import { describeRequirement } from '../../../hooks/domain/requirements'
import { flowDefinitions } from '../../../hooks/domain/flow-definitions'
import { createEmptySession, createEmptyUnit } from '../../../hooks/domain/records'
import type { UnitEntry } from '../../../hooks/domain/records'
import type { Position } from '../../../hooks/domain/step-states'
import { expect } from 'claude-code/testing'
import type { On } from 'claude-code'

import { test } from '../../support/kit'
import { buildParentPullRequest, buildPullRequest, fixed, diagnosisComment, noFlow, pushedCloseOut } from '../../support/builders'
import { declareFlow, endTurn, readFlowStatus, readPromptContext, readStepStates, startSkill } from '../../support/helpers'
import { buildChildEntry, buildRoundPullRequest, parentCheckout, readObservedEndFile, roundCloseOut, seedChildren, seedObservedEnd, withCommit, withoutBranch } from '../../support/parallel-worktrees'
import { common, createWorld, linearGraph } from '../../support/world'
import type { Checkout, Options, World } from '../../support/world'

test('a pushed slice with an open PR closing every issue and green CI completes PR without running a skill', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, pushedCloseOut)
  expect(await readFlowStatus($)).toContain('✓ PR #5')
  expect(await readFlowStatus($)).toContain('Start new session: /clear')
})

test('a PR ahead of the slice end also contains it', async ($, on) => {
  const graph = linearGraph({ feat: 1, remote: 2 })
  createWorld(on, { branch: 'feat', graph }, { ...pushedCloseOut, prs: [buildPullRequest({ headRefOid: 'c2' })] })
  expect(await readFlowStatus($)).toContain('✓ PR #5')
})

for (const unpublished of [[], ['c1']]) {
  test(`an unpushed slice shows the push fact, including a compare 404 (${unpublished.length})`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ headRefOid: 'c0' })], unpublished })
    expect(await readFlowStatus($)).toContain("▸ PR #5 · last commit not pushed")
    expect(await readPromptContext($)).toContain('ask the user to push the branch to PR #5')
  })
}

test('a slice not pushed yet can become readable on the next GitHub refresh', async ($, on) => {
  const options: Options = { ...pushedCloseOut, unpublished: ['c1'] }
  const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, options)
  expect(await readFlowStatus($)).toContain('last commit not pushed')
  options.unpublished = []
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ PR #5')
})

test('a PR opened by a Bash call shows at the next pane judgement, before the cached candidates expire', async ($, on) => {
  const options: Options = { ...pushedCloseOut, prs: [] }
  options.afterTool = () => { options.prs = [buildPullRequest()] }
  const { views } = createWorld(on, { branch: 'feat', ahead: 1 }, options)
  await endTurn($)
  expect(views.at(-1)?.steps.find(step => step.id === 'pr')?.detail).toBe('no PR')
  await $.tool.call({ tool: 'Bash', command: 'gh pr create' })
  await endTurn($)
  expect(views.at(-1)?.steps.find(step => step.id === 'pr')).toMatchObject({ state: 'done', label: 'PR #5' })
})

test('PR closure comes from closingIssuesReferences for every declared issue', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ closingIssuesReferences: [{ number: 1 }] })] })
  expect(await readFlowStatus($)).toContain('▸ PR #5 · missing Closes #2')
  await startSkill($, 'create-pr')
  expect(await readPromptContext($)).toContain('update PR #5 (body must carry Closes #1, Closes #2)')
})

for (const changes of [{ state: 'CLOSED' }, { isCrossRepository: true }, { headRefName: 'other' }]) {
  test(`a noncandidate is no PR: ${JSON.stringify(changes)}`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest(changes)] })
    expect(await readFlowStatus($)).toContain('▸ PR · no PR')
    expect(await readPromptContext($)).toContain('create-pr skill to open the PR')
  })
}

test('an open PR into a non-default base is the unit\'s PR and closes the issues its body names', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ baseRefName: 'next', closingIssuesReferences: [], body: 'Closes #1\nfixes: owner/repo#2' })] })
  expect(await readFlowStatus($)).toContain('✓ PR #5')
})

test('a PR into a non-default base whose body lacks an issue does not close it and is updated, not opened', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ baseRefName: 'next', closingIssuesReferences: [], body: 'Closes #1\nSee #2' })] })
  expect(await readFlowStatus($)).toContain('▸ PR #5 · missing Closes #2')
  await startSkill($, 'create-pr')
  expect(await readPromptContext($)).toContain('update PR #5 (body must carry Closes #1, Closes #2)')
})

test('on a PR into the default branch the body never widens GitHub\'s closing references', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ closingIssuesReferences: [{ number: 1 }], body: 'Closes #1\nCloses #2' })] })
  expect(await readFlowStatus($)).toContain('▸ PR #5 · missing Closes #2')
})

test('CI on a PR into a non-default base waits on that base\'s required checks', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ baseRefName: 'next', body: 'Closes #1, closes #2' })] })
  await readPromptContext($)
  expect(world.runs).toContain('gh api --include repos/{owner}/{repo}/rules/branches/next')
  expect(world.runs).not.toContain('gh api --include repos/{owner}/{repo}/rules/branches/main')
})

test('several open PRs from the unit branch are refused by name instead of picking one', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest(), buildPullRequest({ number: 7, baseRefName: 'next' })] })
  const status = await readFlowStatus($)
  expect(status).toContain('#5')
  expect(status).toContain('#7')
  expect(status).not.toContain('✓ PR')
})

test('a capped candidate list is unchecked instead of selecting a PR', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prsHasNextPage: true })
  expect(await readFlowStatus($)).toContain('▸ PR · GitHub unreachable')
})

test('an incomplete closing-issues connection is unchecked instead of guessing the PR closures', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({
    closingIssuesReferences: { nodes: [{ number: 1 }, { number: 2 }], pageInfo: { hasNextPage: true } },
  })] })
  expect(await readFlowStatus($)).toContain('▸ PR · GitHub unreachable')
})

test('a complete hundred-candidate connection can select a PR', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: Array.from({ length: 100 }, (_, index) => buildPullRequest({ number: index + 1, state: index ? 'CLOSED' : 'OPEN' })) })
  expect(await readFlowStatus($)).toContain('✓ PR #1')
})

test('Trivial needs no closing issue and a draft PR is accepted', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, session: { flow: 'trivial', issues: [], info: {} }, prs: [buildPullRequest({ closingIssuesReferences: [], isDraft: true })] })
  expect(await readFlowStatus($)).toContain('✓ PR #5')
})

test('a current PR step without a skill names its PR', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, session: { flow: 'trivial', issues: [], info: {} }, prs: [buildPullRequest({ closingIssuesReferences: [], headRefOid: 'c0' })], unpublished: [] })
  expect(await readFlowStatus($)).toContain('▸ PR #5')
})

test('an empty slice never selects a merged PR', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, session: { flow: 'trivial', issues: [], info: {} }, unit: { base: 'c1', skips: [{ step: 'code', reason: 'covered' }, { step: 'verify', reason: 'covered' }, { step: 'commit', reason: 'covered' }] }, prs: [buildPullRequest({ state: 'MERGED' })] })
  expect(await readFlowStatus($)).toContain('PR · no PR')
  expect(await readFlowStatus($)).not.toContain('PR #5 · merged')
})

test('declaring with a PR available keeps its facts out of authoritative records', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, session: noFlow })
  const { sessions, files } = world
  expect((await declareFlow($, 'close-out', [1, 2])).deny).toBeUndefined()
  expect((await readStepStates(world)).PR).toBe('done')
  expect(JSON.stringify(sessions.get('sid'))).not.toContain('headRefOid')
  expect([...files.values()].some(text => text.includes('closingIssuesReferences'))).toBe(false)
})

test('a Fix PR requires its issue closures without a diagnosis comment link', async ($, on) => {
  const options: Options = {
    ...pushedCloseOut,
    session: { flow: 'fix', issues: [1, 2], info: {
      1: { title: 'bug', labels: ['ready-for-agent'], comments: [diagnosisComment] },
      2: { title: 'related', labels: ['ready-for-agent'], comments: [] },
    } },
    unit: { ...fixed, skips: [{ step: 'verify', reason: 'covered separately' }] },
    prs: [buildPullRequest({ closingIssuesReferences: [{ number: 1 }] })],
    issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'] }, comments: { 1: [diagnosisComment], 2: [] },
  }
  const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, options)
  expect(await readFlowStatus($)).toContain('missing Closes #2')
  expect(await readPromptContext($)).not.toContain('diagnosis comment link')
  options.prs = [buildPullRequest()]
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ PR #5')
  expect(await readFlowStatus($)).toContain('Start new session: /clear')
})

test('every PR next action records uncaptured context once, except a retry', () => {
  const flow = flowDefinitions.flows['close-out']!
  const pr = flow.steps.find(step => step.observe === 'pr.created')!
  const position: Position = { flow, unit: createEmptyUnit(), git: null, slice: null, states: [], current: null,
    verify: { fact: '', isVerified: false, isReached: false }, checks: 'off', isConcluded: false }
  const session = createEmptySession('sid')
  const clause = 'before the unit counts as finished, record on the issue or PR any session context no issue captured (a dead end explored, an approach ruled out)'
  for (const skill of [pr.skill, undefined]) {
    for (const pullRequest of [undefined, { number: 5, state: 'OPEN' as const }]) {
      for (const factCode of [undefined, 'push-required', 'github-unreachable', 'ci-unreadable'] as const) {
        const instruction = describeRequirement({ step: { ...pr, skill }, state: 'current', factCode, isError: false, isWaitingApproval: false }, session, { ...position, pullRequest })
        expect(instruction.split(clause).length - 1).toBe(factCode === 'github-unreachable' || factCode === 'ci-unreadable' ? 0 : 1)
      }
    }
  }
})

/**
 * Creates the Close out on `par` for #1, with child units of `par` left in another chat's records.
 * @param on - The engine's event registration.
 * @param checkout - The parent's checkout.
 * @param prs - The PRs GitHub lists.
 * @param children - The child entries, none for a clone without records.
 * @param options - Options that replace the Close out's defaults.
 * @returns Once the records are seeded.
 */
async function createRound(on: On, checkout: Checkout, prs: Record<string, unknown>[], children: UnitEntry[], options: Options = {}): Promise<void> {
  const world = createWorld(on, checkout, { ...roundCloseOut, prs, ...options })
  await world.ready
  if (children.length) await seedChildren(world, children)
}

/** Children `a` (#2) and `b` (#3) integrated into `par`, which now sits on their merges (`mpar`). */
const integrated = (): [Checkout, UnitEntry[]] => [parentCheckout({ par: 'mpar', b: 'b2' }), [buildChildEntry('a', 2), buildChildEntry('b', 3)]]

test("a Close out on an integration branch requires only its declared issues and its integrated, unconcluded children's", async ($, on) => {
  const checkout = parentCheckout({ par: 'mpar', b: 'b2' })
  checkout.graph = withCommit(checkout.graph!, 'cc1', ['p2'], 'c')
  // why: `a` was delivered by the earlier round's PR #8, `b` is integrated, `c` is cut from `par` but not merged into it.
  const children = [buildChildEntry('a', 2), buildChildEntry('b', 3), buildChildEntry('c', 4, { base: 'p2' })]
  await createRound(on, checkout, [buildParentPullRequest({ number: 8, headRefOid: 'ma' }), buildRoundPullRequest('mpar', [1])], children)
  expect(await readFlowStatus($)).toContain('▸ PR #10 · missing Closes #3')
  await startSkill($, 'create-pr')
  expect(await readPromptContext($)).toContain('update PR #10 (body must carry Closes #1, Closes #3)')
})

test("a Close out's PR that closes its declared issues and every integrated child's completes PR", async ($, on) => {
  const [checkout, children] = integrated()
  await createRound(on, checkout, [buildRoundPullRequest('mpar', [1, 2, 3])], children)
  expect(await readFlowStatus($)).toContain('✓ PR #10')
})

test('a child delivered into the parent by a merged PR of its own stays required', async ($, on) => {
  const own = buildPullRequest({ number: 7, state: 'MERGED', headRefName: 'b', baseRefName: 'par', headRefOid: 'b2' })
  await createRound(on, parentCheckout({ par: 'mpar', b: 'b2' }), [own, buildRoundPullRequest('mpar', [1])], [buildChildEntry('b', 3)])
  expect(await readFlowStatus($)).toContain('▸ PR #10 · missing Closes #3')
})

test('two children carrying the same issue require it once', async ($, on) => {
  await createRound(on, parentCheckout({ par: 'mpar', b: 'b2' }), [buildRoundPullRequest('mpar', [1])], [buildChildEntry('a', 3), buildChildEntry('b', 3)])
  expect(await readFlowStatus($)).toContain('▸ PR #10 · missing Closes #3')
  await startSkill($, 'create-pr')
  expect(await readPromptContext($)).toContain('update PR #10 (body must carry Closes #1, Closes #3);')
})

test('a stranded child, left out of the parent PR that merged, is required in the next one', async ($, on) => {
  await createRound(on, parentCheckout({ par: 'mpar', b: 'b2' }), [buildParentPullRequest({ number: 8, headRefOid: 'ma' })], [buildChildEntry('b', 3)])
  expect(await readFlowStatus($)).toContain('▸ PR · no PR')
  expect(await readPromptContext($)).toContain('open the PR (body must carry Closes #1, Closes #3)')
})

test('with no records of child units, as on another clone, a Close out requires only its declared issues', async ($, on) => {
  await createRound(on, parentCheckout({ par: 'mpar', b: 'b2' }), [buildRoundPullRequest('mpar', [1])], [])
  expect(await readFlowStatus($)).toContain('✓ PR #10')
})

test('a child re-declared against the default branch leaves the required set', async ($, on) => {
  await createRound(on, parentCheckout({ par: 'mpar', b: 'b2' }), [buildRoundPullRequest('mpar', [1])], [buildChildEntry('b', 3, { baseBranch: 'main' })])
  expect(await readFlowStatus($)).toContain('✓ PR #10')
})

test("unreadable children hold a Close out's PR step on a retry instead of requiring fewer issues", async ($, on) => {
  const [checkout, children] = integrated()
  await createRound(on, checkout, [buildRoundPullRequest('mpar', [1])], children, { failing: 'gh api graphql -F owner={owner} -F name={repo} -f head=b ' })
  expect(await readFlowStatus($)).toContain('▸ PR · children unreadable: ')
  expect(await readPromptContext($)).toContain('Next action: retry; if it keeps failing, stop and tell the user.')
})

test('a child merged into the parent, observed, then deleted stays integrated and required, judged on its observed end', async ($, on) => {
  const checkout = parentCheckout({ par: 'mpar', b: 'b2' })
  const options: Options = { ...roundCloseOut, prs: [buildRoundPullRequest('mpar', [1])] }
  const world = createWorld(on, checkout, options)
  await world.ready
  await seedChildren(world, [buildChildEntry('b', 3)])
  expect(await readFlowStatus($)).toContain('▸ PR #10 · missing Closes #3')
  expect(await readObservedEndFile(world, { branch: 'b', issues: [3] }, 'sid')).toBe('b2')
  checkout.graph = withoutBranch(checkout.graph!, 'b')
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain('▸ PR #10 · missing Closes #3\n')
  await startSkill($, 'create-pr')
  expect(await readPromptContext($)).toContain('update PR #10 (body must carry Closes #1, Closes #3)')
})

/** The fact a Close out's PR step shows for child `b` (#3) deleted before any session observed its end. */
const neverObserved = '▸ PR #10 · child #3: end never observed (branch deleted) — verify it is merged, then add Closes #3 to the PR or close #3'

/**
 * Creates a round whose child `b` (#3) was merged into `par` and deleted with no judgement in between.
 * @param on - The engine hooks.
 * @param options - Options that replace the round's; their PRs stay live for the test to change.
 * @returns The world.
 */
async function createUnobservedRound(on: On, options: Options): Promise<World> {
  const world = createWorld(on, { ...parentCheckout(), graph: withoutBranch(parentCheckout({ par: 'mpar' }).graph!, 'b') }, options)
  await world.ready
  await seedChildren(world, [buildChildEntry('b', 3)])
  return world
}

test("a child deleted before its end was observed blocks the Close out's PR until the PR closes its issue", async ($, on) => {
  const options: Options = { ...roundCloseOut, prs: [buildRoundPullRequest('mpar', [1])] }
  const world = await createUnobservedRound(on, options)
  expect(await readFlowStatus($)).toContain(neverObserved)
  const context = await readPromptContext($)
  expect(context).toContain("Next action: the user's step: stop and ask them to check that the child's work is merged, then add its Closes line to the PR or close its issue (never do either yourself).")
  options.prs = [buildRoundPullRequest('mpar', [1, 3])]
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ PR #10')
})

test("a child deleted before its end was observed stops blocking the Close out's PR once its issue is closed", async ($, on) => {
  const options: Options = { ...roundCloseOut, prs: [buildRoundPullRequest('mpar', [1])] }
  const world = await createUnobservedRound(on, options)
  expect(await readFlowStatus($)).toContain(neverObserved)
  options.issues = { 3: 'CLOSED' }
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ PR #10')
})

test("a child whose observed ends diverge blocks the Close out's PR as ambiguous, and its issue is never in the PR guidance", async ($, on) => {
  const checkout = parentCheckout({ par: 'mpar', b: 'b2' })
  checkout.graph = withoutBranch(withCommit(withCommit(checkout.graph!, 'bx', ['b2']), 'by', ['b2']), 'b')
  const world = createWorld(on, checkout, { ...roundCloseOut, prs: [buildRoundPullRequest('mpar', [1, 2])] })
  await world.ready
  const child = buildChildEntry('b', 3)
  await seedChildren(world, [child, buildChildEntry('a', 2)])
  await seedObservedEnd(world, child.identity, 'x', 'bx', child.generation!)
  await seedObservedEnd(world, child.identity, 'y', 'by', child.generation!)
  expect(await readFlowStatus($)).toContain('▸ PR #10 · child #3: end ambiguous — verify it is merged, then add Closes #3 to the PR or close #3')
})

test("an issue the Close out declares itself is never left to the user, even when a child with an unknown end shares it", async ($, on) => {
  const options: Options = { ...roundCloseOut, prs: [buildRoundPullRequest('mpar', [])] }
  const world = createWorld(on, { ...parentCheckout(), graph: withoutBranch(parentCheckout({ par: 'mpar' }).graph!, 'b') }, options)
  await world.ready
  await seedChildren(world, [buildChildEntry('b', 1)])
  expect(await readFlowStatus($)).toContain('▸ PR #10 · missing Closes #1\n')
  await startSkill($, 'create-pr')
  expect(await readPromptContext($)).toContain('update PR #10 (body must carry Closes #1);')
})

test("an issue the Close out delivers is reported before an unknown end's", async ($, on) => {
  const options: Options = { ...roundCloseOut, prs: [buildRoundPullRequest('mpar', [])] }
  await createUnobservedRound(on, options)
  expect(await readFlowStatus($)).toContain('▸ PR #10 · missing Closes #1')
  await startSkill($, 'create-pr')
  expect(await readPromptContext($)).toContain('update PR #10 (body must carry Closes #1);')
})

test("an unreadable issue of a child with an unknown end holds the Close out's PR step on a retry", async ($, on) => {
  await createUnobservedRound(on, { ...roundCloseOut, prs: [buildRoundPullRequest('mpar', [1])], missing: [3] })
  expect(await readFlowStatus($)).toContain('▸ PR · children unreadable: ')
})

test("an unparsable session mirror holds a Close out's PR step instead of dropping the children it may hold", async ($, on) => {
  const [checkout, children] = integrated()
  const world = createWorld(on, checkout, { ...roundCloseOut, prs: [buildRoundPullRequest('mpar', [1, 2, 3])] })
  await world.ready
  await seedChildren(world, children)
  world.files.set(`${common}/working-agreement/s/broken.json`, '{')
  expect(await readFlowStatus($)).toContain('▸ PR · children unreadable: unreadable session mirror broken.json')
})

test("a session mirror listing that fails holds a Close out's PR step instead of reading as no children", async ($, on) => {
  const [checkout, children] = integrated()
  await createRound(on, checkout, [buildRoundPullRequest('mpar', [1, 2, 3])], children, { listFailurePrefix: `${common}/working-agreement/s` })
  expect(await readFlowStatus($)).toContain('▸ PR · children unreadable: ')
})
