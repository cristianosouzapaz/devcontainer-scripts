/** Names whether the PR must close every declared issue. */
type PullRequestRequirement = 'closes' | 'none'

/** Names the observed evidence that completes a step: a passing verify run, the unit's commit, its confirmed PR, or its slice reached from its parent branch. */
type StepEvidence = 'verify.passed' | 'commit' | 'pr.created' | 'integrated'

/**
 * Describes a flow step and the evidence that completes it.
 * The Diagnose step is completed by its sub-steps; an optional unfinished step is skipped
 * without holding later steps back.
 */
export interface Step {
  id: string
  label: string
  skill?: string
  isHuman?: boolean
  isOptional?: boolean
  isUnlocking?: boolean
  observe?: StepEvidence
  requires?: PullRequestRequirement
  isInWorktree?: boolean
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
  steps: Step[]
}

/** Holds the flow definitions keyed by flow id. */
interface AgreementDefinitions { flows: Record<string, FlowDefinition> }

/** Holds the working agreement's flows; typed code rather than JSON, so the compiler checks every definition. */
export const flowDefinitions: AgreementDefinitions = {
  flows: {
    'large-feature': {
      label: 'Large feature', issue: 'produced', declaredBy: 'agent',
      steps: [
        { id: 'map', label: 'Map', skill: 'wayfinder', isHuman: true },
        { id: 'tickets', label: 'Tickets', skill: 'to-tickets', isHuman: true },
      ],
    },
    'small-feature': {
      label: 'Small feature', issue: 'produced', declaredBy: 'agent',
      steps: [
        { id: 'grill', label: 'Grill', skill: 'grilling' },
        { id: 'spec', label: 'Spec', skill: 'to-spec', isHuman: true },
        { id: 'tickets', label: 'Tickets', skill: 'to-tickets', isHuman: true, isOptional: true },
        { id: 'code', label: 'Code', isUnlocking: true },
        ...buildDeliverySteps('closes'),
      ],
    },
    fix: {
      label: 'Fix', issue: 'produced', declaredBy: 'agent',
      steps: [
        { id: 'triage', label: 'Triage', skill: 'triage', isHuman: true },
        { id: 'diagnose', label: 'Diagnose', skill: 'diagnosing-bugs', isInWorktree: true },
        { id: 'code', label: 'Code', isUnlocking: true },
        ...buildDeliverySteps('closes'),
      ],
    },
    'close-out': {
      label: 'Close out', issue: 'required', declaredBy: 'agent',
      steps: buildDeliverySteps('closes'),
    },
    'follow-up': {
      label: 'Follow-up', issue: 'inherited', declaredBy: 'human',
      steps: [
        { id: 'code', label: 'Code', isUnlocking: true },
        ...buildDeliverySteps('closes'),
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
}

/** Replaces PR as a child unit's last step, which the user completes by merging the child into its parent branch. */
const integrateStep: Step = { id: 'integrate', label: 'Integrate', observe: 'integrated' }

/**
 * Looks up a declared flow without accepting inherited object properties.
 * @param id - The declared flow id, or null with none declared.
 * @returns The matching definition, or undefined for an unknown id.
 */
export function findFlow(id: string | null): FlowDefinition | undefined {
  return id && Object.hasOwn(flowDefinitions.flows, id) ? flowDefinitions.flows[id] : undefined
}

/**
 * Tells whether a flow judges Diagnose runs and approval.
 * @param flow - The declared flow, if known.
 * @returns True when the flow has a worktree Diagnose step.
 */
export const hasDiagnoseStep = (flow: FlowDefinition | undefined): boolean => !!flow?.steps.some(step => step.isInWorktree)

/**
 * Tells whether a flow judges an issue's sub-issue tree.
 * @param flow - The declared flow, if known.
 * @returns True when Map or Tickets is present.
 */
export const hasIssueTreeStep = (flow: FlowDefinition | undefined): boolean => !!flow?.steps.some(step => step.id === 'map' || step.id === 'tickets')

/**
 * Gives a unit its steps: a child unit ends with Integrate in place of PR, while the flow definitions stay fixed.
 * @param flow - The declared flow.
 * @param isChild - Whether the unit's cached base branch is a parent branch other than the default branch.
 * @returns The flow as the unit runs it.
 */
export function resolveUnitFlow(flow: FlowDefinition, isChild: boolean): FlowDefinition {
  return isChild ? { ...flow, steps: flow.steps.map(step => step.observe === 'pr.created' ? integrateStep : step) } : flow
}

/**
 * Tells whether a step delivers the unit: PR, or Integrate for a child unit.
 * @param step - The flow step.
 * @returns True for the unit's last, delivering step.
 */
export const isDeliveryStep = (step: Step): boolean => step.observe === 'pr.created' || step.observe === 'integrated'

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
