/** Whether a step that is not done blocks a repository write, asks the user first, or lets it through. */
export type Gate = 'deny' | 'ask' | 'none'

/**
 * What a PR body must carry: `closes` a Closes line per declared issue, `refs` a Refs line for the followed-up issue,
 * `linked` a line linking the followed-up issue with any of Closes, Refs, Fixes or Resolves.
 */
export type PrRequirement = 'closes' | 'refs' | 'linked' | 'none'

/** One step of a flow: the skill or observed event that completes it, and how it gates repository writes. */
export interface Step {
  id: string; label: string; skill?: string; human?: boolean; produces?: 'issue'
  gate?: Gate; unlocks?: 'write'; observe?: string; requires?: PrRequirement
  skipIfIssue?: boolean; exempt?: 'tests'
}

/** How a flow relates to an issue: it needs one, creates one, has none, or takes the followed-up one. */
export type IssueRelation = 'required' | 'produced' | 'none' | 'inherited'

/** Who may declare a flow. */
export type Declarer = 'agent' | 'human'

/** A flow of the working agreement: who declares it, how it relates to an issue, and its ordered steps. */
export interface FlowDef {
  label: string; issue: IssueRelation
  declaredBy: Declarer; repoWrites?: 'deny'; steps: Step[]; skipTo?: Record<string, string>
}

/** Repository paths no flow may write: planning files and generated copies. */
export interface PathGlobs { ephemeral: string[]; generated: string[] }

/** Everything the hooks enforce, keyed by flow id, with the globs and patterns the write checks use. */
export interface Defs {
  flows: Record<string, FlowDef>; issueSkills: string[]; testPaths: string[]
  paths: PathGlobs; bashWritePatterns: string[]
}

/** The working agreement's flows; typed code rather than JSON, so the compiler checks every definition. */
export const flowDefs: Defs = {
  flows: {
    'large-feature': {
      label: 'Large feature', issue: 'produced', declaredBy: 'agent', repoWrites: 'deny',
      steps: [
        { id: 'map', label: 'Map', skill: 'wayfinder', human: true, produces: 'issue' },
        { id: 'tickets', label: 'Tickets', skill: 'to-tickets', human: true },
      ],
    },
    'small-feature': {
      label: 'Small feature', issue: 'produced', declaredBy: 'agent',
      steps: [
        { id: 'grill', label: 'Grill', skill: 'grilling', gate: 'ask' },
        { id: 'spec', label: 'Spec', skill: 'to-spec', human: true, produces: 'issue', gate: 'ask' },
        { id: 'code', label: 'Code', unlocks: 'write' },
        ...deliverySteps('closes'),
      ],
      skipTo: { 'label:ready-for-agent': 'code' },
    },
    fix: {
      label: 'Fix', issue: 'produced', declaredBy: 'agent',
      steps: [
        { id: 'triage', label: 'Triage', skill: 'triage', human: true, produces: 'issue', gate: 'ask', skipIfIssue: true },
        { id: 'diagnose', label: 'Diagnose', skill: 'diagnosing-bugs', gate: 'ask', exempt: 'tests' },
        { id: 'code', label: 'Code', unlocks: 'write' },
        ...deliverySteps('closes'),
      ],
    },
    'close-out': {
      label: 'Close out', issue: 'required', declaredBy: 'agent',
      steps: deliverySteps('closes'),
    },
    'follow-up-open': {
      label: 'Follow-up', issue: 'inherited', declaredBy: 'human',
      steps: [
        { id: 'code', label: 'Code', unlocks: 'write' },
        ...deliverySteps('linked'),
      ],
    },
    'follow-up-merged': {
      label: 'Follow-up', issue: 'inherited', declaredBy: 'human',
      steps: [
        { id: 'code', label: 'Code', unlocks: 'write' },
        ...deliverySteps('refs'),
      ],
    },
    trivial: {
      label: 'Trivial change', issue: 'none', declaredBy: 'human',
      steps: [
        { id: 'change', label: 'Change', unlocks: 'write' },
        ...deliverySteps('none', false),
      ],
    },
  },
  issueSkills: ['to-spec', 'triage', 'to-tickets', 'wayfinder'],
  testPaths: ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/*.bats'],
  paths: {
    ephemeral: ['**/PLAN.md', '**/SPEC.md', '**/TODO.md', '**/TODOS.md', '**/plans/**', 'docs/plans/**', '**/*.plan.md'],
    generated: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/vendor/**', '**/.venv/**'],
  },
  bashWritePatterns: ['\\d*>>?\\s*[^&\\s]', '\\bsed\\s+(-\\w*\\s+)*-i', '\\btee\\b', '\\b(cp|mv)\\b'],
}

/**
 * Builds the Verify, Commit and PR steps every repository-writing flow ends with.
 *
 * @param requires - What the PR body must carry.
 * @param hasSkills - Whether Commit and PR run their skills; without them the agent commits and opens the PR itself.
 * @returns The three steps, in order.
 */
function deliverySteps(requires: PrRequirement, hasSkills = true): Step[] {
  return [
    { id: 'verify', label: 'Verify', observe: 'verify.passed' },
    { id: 'commit', label: 'Commit', ...(hasSkills ? { skill: 'generate-commit' } : {}), observe: 'commit', gate: 'none' },
    { id: 'pr', label: 'PR', ...(hasSkills ? { skill: 'create-pr' } : {}), observe: 'pr.created', requires },
  ]
}
