import type { ElementTable, RenderElement } from 'claude-code'

import type { FlowFooter, FlowIssue, FlowRow, FlowStep, RunView } from '../../types'
import { drawRule } from './pane-layout'
import { issueGap, keyWidth, labelColor, panePadding, pillGap, pillRowGap, stepSymbol, symbolColor, toneColor } from './theme'

/** The elements the Flow pane draws with, which `$.ui.resolve(e)` hands out. */
export type PaneElements = Pick<ElementTable, 'Box' | 'Text' | 'Button'>

/** The flow's name, its progress and the body's width. */
interface HeaderProps {
  flow: string
  progress: string
  columns: number
}

/** The pending text, the issues and what pressing `open` does. */
interface IssueListProps {
  pending: string | null
  issues: FlowIssue[]
  openIssue: (issueNumber: number) => void
}

/** The rows of labels, from `layoutLabelRows`. */
interface LabelRowsProps {
  rows: string[][]
}

/** The rows of a keyed section. */
interface KeyedRowsProps {
  rows: FlowRow[]
}

/** The steps of the flow. */
interface StepListProps {
  steps: FlowStep[]
  run?: RunView
}

/** The footer, the body's width and what pressing the button does. */
interface FooterProps {
  footer: FlowFooter | null
  hasRunLog?: boolean
  openRunLog: () => void
  columns: number
  startHandoff: () => void
  startNewSession: () => void
}

/** A footer button's address, label, hotkey and presentation. */
interface FooterButton {
  address: string
  label: string
  hotkey: string
  onPress: () => void
  variant?: 'primary'
  dimColor?: boolean
}

/** The columns between two footer buttons drawn side by side. */
const footerGap = 2

/**
 * Measures a button as the terminal draws it, `[ label ]`.
 * @param label - The button's label.
 * @returns Its width, in characters.
 */
function measureButton(label: string): number {
  return `[ ${label} ]`.length
}

/**
 * Draws the pane's title row, the flow's name and its progress, over the rule.
 *
 * @param elements - The element table.
 * @param props - The flow's name, its progress and the body's width.
 * @returns The header.
 */
export function drawHeader({ Box, Text }: PaneElements, props: HeaderProps): RenderElement {
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text weight="semibold" color="text" wrap="truncate-end">{props.flow}</Text>
        <Box flexShrink={0}><Text color="inactive">{props.progress}</Text></Box>
      </Box>
      <Text color="subtle">{drawRule(props.columns)}</Text>
    </Box>
  )
}

/**
 * Draws the pending text and the issues, each with a button that opens it.
 *
 * @param elements - The element table.
 * @param props - The pending text, the issues and what pressing `open` does.
 * @returns The issue list.
 */
export function drawIssueList({ Box, Text, Button }: PaneElements, props: IssueListProps): RenderElement {
  return (
    <Box flexDirection="column">
      {props.pending && <Text color="inactive">{props.pending}</Text>}
      {props.issues.map((issue, index) => (
        <Box flexDirection="column">
          <Box gap={issueGap}>
            <Box flexShrink={0}><Text color="suggestion">#{issue.number}</Text></Box>
            <Box flexShrink={0}><Button key={`open-${issue.number}`} label="open" hotkey={index === 0 ? 'o' : undefined} onPress={() => props.openIssue(issue.number)} /></Box>
          </Box>
          {issue.title && <Text color="inactive" wrap="truncate-end">{issue.title}</Text>}
        </Box>
      ))}
    </Box>
  )
}

/**
 * Draws the label pills row by row, the key on the first row only.
 *
 * @param elements - The element table.
 * @param props - The rows of labels, from `layoutLabelRows`.
 * @returns The label rows.
 */
export function drawLabelRows({ Box, Text }: PaneElements, props: LabelRowsProps): RenderElement {
  return (
    <Box>
      <Box width={keyWidth} flexShrink={0}><Text color="inactive">Labels</Text></Box>
      <Box flexDirection="column" gap={pillRowGap}>
        {props.rows.map(row => (
          <Box gap={pillGap}>
            {row.map(label => <Text backgroundColor="subtle" color="text" wrap="truncate-end">{` ${label} `}</Text>)}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/**
 * Keeps metadata values aligned while preserving suffix tone and branch truncation.
 * @param elements - The pane's render elements.
 * @param row - The metadata row.
 * @returns The rendered metadata row.
 */
function drawMetaRow({ Box, Text }: PaneElements, row: FlowRow): RenderElement {
  return (
    <Box>
      <Box width={keyWidth} flexShrink={0}>
        <Text color="inactive">{row.key}</Text>
      </Box>
      <Text wrap={row.key === 'Branch' ? 'truncate-middle' : 'wrap'} color={toneColor[row.tone]}>{row.value}</Text>
      {row.suffix && <Box flexShrink={0}><Text color="inactive"> · </Text><Text color={toneColor[row.suffix.tone]}>{row.suffix.text}</Text></Box>}
    </Box>
  )
}

/**
 * Emphasizes a note's label without truncating its explanation.
 * @param elements - The pane's render elements.
 * @param row - The note row.
 * @returns The rendered note row.
 */
function drawNoteRow({ Box, Text }: PaneElements, row: FlowRow): RenderElement {
  return (
    <Box>
      <Box width={keyWidth} flexShrink={0}>
        <Text color={toneColor[row.tone]} weight="semibold">{row.key}</Text>
      </Box>
      <Text color="text" wrap="wrap">{row.value}</Text>
    </Box>
  )
}

/**
 * Draws the meta rows, such as the branch.
 *
 * @param elements - The element table.
 * @param props - The rows.
 * @returns The meta rows.
 */
export function drawMetaRows(elements: PaneElements, props: KeyedRowsProps): RenderElement {
  return <elements.Box flexDirection="column">{props.rows.map(row => drawMetaRow(elements, row))}</elements.Box>
}

/**
 * Converts domain evidence into the step shown during a live run.
 * @param step - The evidence-backed flow step.
 * @param runningId - The step the live run belongs to, when one runs.
 * @returns The step with temporary live-run presentation applied.
 */
function toDrawnStep(step: FlowStep, runningId?: string): FlowStep {
  if (!runningId) return step
  if (step.id === runningId) return { ...step, symbol: stepSymbol.current, state: 'current', detail: undefined, isError: false, isMerged: false }
  return step.state === 'current'
    ? { ...step, symbol: step.symbol === '?' ? '?' : stepSymbol.pending, state: 'pending', detail: undefined, isError: false, isMerged: false }
    : step
}

/**
 * Draws the flow's steps with their state marks and facts.
 *
 * @param elements - The element table.
 * @param props - The steps.
 * @returns The step list.
 */
export function drawStepList({ Box, Text }: PaneElements, props: StepListProps): RenderElement {
  // A red or green run belongs to whichever step is current; only Verify runs as a step of its own.
  const runningId = props.run && (props.run.kind === 'Verify' ? 'verify' : props.steps.find(step => step.state === 'current')?.id)
  return (
    <Box flexDirection="column">
      {props.steps.map(step => {
        const drawn = toDrawnStep(step, runningId)
        return <Box flexDirection="column">
          <Box>
            <Box width={2} flexShrink={0}><Text color={drawn.isError ? 'error' : drawn.isMerged ? 'merged' : drawn.symbol === '?' ? 'inactive' : symbolColor[drawn.state]}>{drawn.isError ? '✗' : drawn.symbol} </Text></Box>
            <Box flexShrink={0}><Text color={drawn.symbol === '?' ? 'inactive' : labelColor[drawn.state]}>{drawn.label}</Text></Box>
            {/* Fragments render as column Boxes, which would stack the fact below its label. */}
            {drawn.detail && [
              <Box flexShrink={0}><Text color="inactive"> · </Text></Box>,
              props.run && drawn.state === 'current' ? <Box flexShrink={0}><Text color="text">{drawn.detail}</Text></Box>
                : drawn.isMerged ? <Box flexShrink={0}><Text color="merged">{drawn.detail}</Text></Box>
                : <Text color={drawn.isError ? 'error' : drawn.state === 'skipped' ? 'inactive' : 'text'} wrap={drawn.state === 'current' ? 'wrap' : 'truncate-end'}>{drawn.detail}</Text>,
            ]}
          </Box>
        </Box>
      })}
    </Box>
  )
}

/**
 * Draws blocked writes and a failed handoff.
 *
 * @param elements - The element table.
 * @param props - The rows.
 * @returns The notes.
 */
export function drawNotes(elements: PaneElements, props: KeyedRowsProps): RenderElement {
  return <elements.Box flexDirection="column">{props.rows.map(row => drawNoteRow(elements, row))}</elements.Box>
}

/**
 * Draws fixed footer actions, stacking inside the pane padding when needed.
 *
 * @param elements - The element table.
 * @param props - The footer, the body's width and what pressing the button does.
 * @returns The footer.
 */
export function drawFooter({ Box, Text, Button }: PaneElements, props: FooterProps): RenderElement {
  const buttons: FooterButton[] = [
    ...props.hasRunLog ? [{ address: 'l', label: 'Run log', hotkey: 'l', onPress: props.openRunLog }] : [],
    ...props.footer ? [props.footer.action === 'start'
      ? { address: 'n', label: 'Start new session', hotkey: 'n', variant: 'primary' as const, dimColor: props.footer.isRunning, onPress: props.startNewSession }
      : { address: 'c', label: 'Continue in new session', hotkey: 'c', variant: 'primary' as const, dimColor: props.footer.isRunning, onPress: props.startHandoff }] : [],
  ]
  const inlineColumns = buttons.reduce((sum, button) => sum + measureButton(button.label), footerGap * (buttons.length - 1))
  const stacked = props.columns - 2 * panePadding.x < inlineColumns
  return (
    <Box flexDirection="column">
      <Text color="subtle">{drawRule(props.columns)}</Text>
      <Box flexDirection={stacked ? 'column' : 'row'} alignItems="flex-end" justifyContent="flex-end" gap={stacked ? 1 : footerGap}>
        {buttons.map(({ address, ...button }) => <Box flexShrink={0}><Button key={address} {...button} /></Box>)}
      </Box>
    </Box>
  )
}
