import type { ElementTable, RenderElement } from 'claude-code'

import type { FlowFooter, FlowIssue, FlowRow, FlowStep } from '../../types'
import { drawRule, fitFact, measureFactWidth } from './pane-layout'
import { issueGap, keyWidth, labelColor, panePadding, pillGap, pillRowGap, symbolColor, toneColor } from './theme'

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

/** The steps of the flow and the body's width. */
interface StepListProps {
  steps: FlowStep[]
  columns: number
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
 * Draws the pending text and the first issue with a button that opens it, then how many more `/flow status` lists, so
 * many issues never push the steps off screen.
 *
 * @param elements - The element table.
 * @param props - The pending text, the issues and what pressing `open` does.
 * @returns The issue list.
 */
export function drawIssueList({ Box, Text, Button }: PaneElements, props: IssueListProps): RenderElement {
  const [issue] = props.issues
  return (
    <Box flexDirection="column">
      {props.pending && <Text color="inactive">{props.pending}</Text>}
      {issue && (
        <Box flexDirection="column">
          <Box gap={issueGap}>
            <Box flexShrink={0}><Text color="suggestion">#{issue.number}</Text></Box>
            <Box flexShrink={0}><Button key={`open-${issue.number}`} label="open" hotkey="o" onPress={() => props.openIssue(issue.number)} /></Box>
          </Box>
          {issue.title && <Text color="inactive" wrap="truncate-end">{issue.title}</Text>}
        </Box>
      )}
      {props.issues.length > 1 && <Text color="inactive" wrap="truncate-end">+{props.issues.length - 1} more · /flow status</Text>}
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
 * Draws the flow's steps with their state marks and facts.
 *
 * @param elements - The element table.
 * @param props - The steps and the body's width, which each fact is fitted to.
 * @returns The step list.
 */
export function drawStepList({ Box, Text }: PaneElements, props: StepListProps): RenderElement {
  return (
    <Box flexDirection="column">
      {props.steps.map(step => (
        <Box flexDirection="column">
          <Box>
            <Box width={2} flexShrink={0}><Text color={step.isError ? 'error' : step.isMerged ? 'merged' : step.isRewritten ? 'inactive' : symbolColor[step.state]}>{step.symbol} </Text></Box>
            <Box flexShrink={0}><Text color={step.isRewritten ? 'inactive' : labelColor[step.state]}>{step.label}</Text></Box>
            {/* Fragments render as column Boxes, which would stack the fact below its label. */}
            {step.detail && [
              <Box flexShrink={0}><Text color="inactive"> · </Text></Box>,
              <Text color={step.isMerged ? 'merged' : step.isError ? 'error' : step.state === 'skipped' ? 'inactive' : 'text'} wrap="truncate-end">{fitFact(step.detail, measureFactWidth(props.columns, step.label))}</Text>,
            ]}
          </Box>
        </Box>
      ))}
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
