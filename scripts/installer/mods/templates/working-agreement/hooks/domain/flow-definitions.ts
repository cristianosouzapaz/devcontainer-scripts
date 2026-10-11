/**
 * Names what a PR body must carry: `closes` a Closes line per declared issue, `refs` a Refs line for the followed-up issue,
 * `linked` a line linking the followed-up issue with any of Closes, Refs, Fixes or Resolves.
 */
type PullRequestRequirement = 'closes' | 'refs' | 'linked' | 'none'

/** Names the observed evidence that completes a step: the declared issue's sub-issues, a passing verify run, the unit's commit, or its confirmed PR. */
type StepEvidence = 'sub-issues' | 'verify.passed' | 'commit' | 'pr.created'

/**
 * Describes one step of a flow: the skill that runs it, the observed evidence that completes it, and how it gates repository writes:
 * only an `isWriteGated` step before the `isUnlocking` one asks before a write, so every other step never does;
 * an `isTestExempt` step (Diagnose) lets test files through and is completed by an observed red;
 * `doneLabels` makes it follow GitHub: it is done while a declared issue carries any of them, and the steps before it show as skipped unless they are done or overridden.
 * An `isOptional` step is skipped until its skill starts or its evidence appears, never gates a write, and never holds the steps after it back.
 */
export interface Step {
  id: string
  label: string
  skill?: string
  isHuman?: boolean
  isOptional?: boolean
  doneLabels?: string[]
  isWriteGated?: boolean
  isUnlocking?: boolean
  observe?: StepEvidence
  requires?: PullRequestRequirement
  isTestExempt?: boolean
}

/** Names how a flow relates to an issue: it needs one, creates one, has none, or takes the followed-up one. */
type IssueRelation = 'required' | 'produced' | 'none' | 'inherited'

/** Names who may declare a flow. */
type Declarer = 'agent' | 'human'

/** Defines a flow of the working agreement: who declares it, how it relates to an issue, and its ordered steps. */
export interface FlowDefinition {
  label: string
  issue: IssueRelation
  declaredBy: Declarer
  isReadOnly?: boolean
  steps: Step[]
}

/** Holds the repository paths no flow may write: planning files and generated copies. */
interface PathGlobs {
  ephemeral: string[]
  generated: string[]
}

/** Holds everything the hooks enforce, keyed by flow id, with the globs the write checks use. */
interface AgreementDefinitions {
  flows: Record<string, FlowDefinition>
  issueSkills: string[]
  testPaths: string[]
  paths: PathGlobs
}

/** Holds the working agreement's flows; typed code rather than JSON, so the compiler checks every definition. */
export const flowDefinitions: AgreementDefinitions = {
  flows: {
    'large-feature': {
      label: 'Large feature', issue: 'produced', declaredBy: 'agent', isReadOnly: true,
      steps: [
        { id: 'map', label: 'Map', skill: 'wayfinder', isHuman: true, doneLabels: ['wayfinder:map'] },
        { id: 'tickets', label: 'Tickets', skill: 'to-tickets', isHuman: true, observe: 'sub-issues' },
      ],
    },
    'small-feature': {
      label: 'Small feature', issue: 'produced', declaredBy: 'agent',
      steps: [
        { id: 'grill', label: 'Grill', skill: 'grilling', isWriteGated: true },
        { id: 'spec', label: 'Spec', skill: 'to-spec', isHuman: true, doneLabels: ['ready-for-agent'], isWriteGated: true },
        { id: 'tickets', label: 'Tickets', skill: 'to-tickets', isHuman: true, observe: 'sub-issues', isOptional: true },
        { id: 'code', label: 'Code', isUnlocking: true },
        ...buildDeliverySteps('closes'),
      ],
    },
    fix: {
      label: 'Fix', issue: 'produced', declaredBy: 'agent',
      steps: [
        { id: 'triage', label: 'Triage', skill: 'triage', isHuman: true, doneLabels: ['ready-for-agent', 'ready-for-human', 'needs-info', 'wontfix'], isWriteGated: true },
        { id: 'diagnose', label: 'Diagnose', skill: 'diagnosing-bugs', isWriteGated: true, isTestExempt: true },
        { id: 'code', label: 'Code', isUnlocking: true },
        ...buildDeliverySteps('closes'),
      ],
    },
    'close-out': {
      label: 'Close out', issue: 'required', declaredBy: 'agent',
      steps: buildDeliverySteps('closes'),
    },
    'follow-up-open': {
      label: 'Follow-up', issue: 'inherited', declaredBy: 'human',
      steps: [
        { id: 'code', label: 'Code', isUnlocking: true },
        ...buildDeliverySteps('linked'),
      ],
    },
    'follow-up-merged': {
      label: 'Follow-up', issue: 'inherited', declaredBy: 'human',
      steps: [
        { id: 'code', label: 'Code', isUnlocking: true },
        ...buildDeliverySteps('refs'),
      ],
    },
    trivial: {
      label: 'Trivial change', issue: 'none', declaredBy: 'human',
      steps: [
        { id: 'code', label: 'Code', isUnlocking: true },
        ...buildDeliverySteps('none', false),
      ],
    },
  },
  issueSkills: ['to-spec', 'triage', 'to-tickets', 'wayfinder'],
  testPaths: ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/*.bats'],
  paths: {
    ephemeral: ['**/PLAN.md', '**/SPEC.md', '**/TODO.md', '**/TODOS.md', '**/plans/**', 'docs/plans/**', '**/*.plan.md'],
    generated: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/vendor/**', '**/.venv/**'],
  },
}

/**
 * Builds the Verify, Commit and PR steps every repository-writing flow ends with.
 *
 * @param requires - What the PR body must carry.
 * @param hasSkills - Whether Commit and PR run their skills; a Trivial change has none to run.
 * @returns The three steps, in order.
 */
function buildDeliverySteps(requires: PullRequestRequirement, hasSkills = true): Step[] {
  return [
    { id: 'verify', label: 'Verify', observe: 'verify.passed' },
    { id: 'commit', label: 'Commit', ...(hasSkills ? { skill: 'generate-commit' } : {}), observe: 'commit' },
    { id: 'pr', label: 'PR', ...(hasSkills ? { skill: 'create-pr' } : {}), observe: 'pr.created', requires },
  ]
}

/**
 * Tells whether a flow has a test-exempt step (Diagnose), the only one an observed red completes.
 *
 * @param flow - The declared flow's id, or null with none declared.
 * @returns True when the flow has a Diagnose step.
 */
export function hasDiagnoseStep(flow: string | null): boolean {
  return !!flow && !!flowDefinitions.flows[flow]?.steps.some(step => step.isTestExempt)
}
