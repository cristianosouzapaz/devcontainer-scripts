/** The color role of a row in the Flow pane. */
export type FlowTone = 'text' | 'muted' | 'warn' | 'error'
/** Where a flow step stands for the current unit of work. */
export type FlowStepState = 'done' | 'current' | 'pending' | 'skipped' | 'override'
/** A labelled line of the Flow pane, such as the branch or a blocked-write count. */
export interface FlowRow { key: string; value: string; tone: FlowTone }
/** One step of the declared flow as the pane shows it, with the user's command when the step is theirs. */
export interface FlowStep { symbol: string; label: string; state: FlowStepState; hint?: string; isStale: boolean }
/** An issue the session's unit of work resolves. */
export interface FlowIssue { number: number; title: string }
/** The pane's closing line, offering to continue in a new session. */
export interface FlowFooter { text: string | null; isRunning: boolean }
/** Everything the Flow pane draws; the session's state holds it, or null with no flow declared. */
export interface FlowView {
  flow: string
  progress: string
  issues: FlowIssue[]
  pending: string | null
  meta: FlowRow[]
  labels: string[]
  steps: FlowStep[]
  notes: FlowRow[]
  footer: FlowFooter | null
}

declare module 'claude-code' {
  interface PluginState {
    // The validator reads this shape in place: it stays inline.
    'working-agreement': { view: FlowView | null }
  }
}
