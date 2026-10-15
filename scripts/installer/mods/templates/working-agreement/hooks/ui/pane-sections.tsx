import type { ElementTable, RenderElement } from 'claude-code'

import type { FlowFooter, FlowIssue, FlowRow, FlowStep, FlowSubStep } from '../../types'
import { drawRule } from './pane-layout'
import { hintIndent, inlineGap, issueGap, keyWidth, labelColor, palette, pillGap, pillRowGap, symbolColor, toneColor } from './theme'

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
}

/** The footer, the body's width and what pressing the button does. */
interface FooterProps {
  footer: FlowFooter
  columns: number
  startHandoff: () => void
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
        <Text bold color={palette.text}>{props.flow}</Text>
        <Text color={palette.muted}>{props.progress}</Text>
      </Box>
      <Text color={palette.pill}>{drawRule(props.columns)}</Text>
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
      {props.pending && <Text color={palette.muted}>{props.pending}</Text>}
      {props.issues.map((issue, index) => (
        <Box flexDirection="column">
          <Box gap={issueGap}>
            <Text color={palette.accent}>#{issue.number}</Text>
            <Button key={`open-${issue.number}`} label="open" hotkey={index === 0 ? 'o' : undefined} onPress={() => props.openIssue(issue.number)} />
          </Box>
          {issue.title && <Text color={palette.muted}>{issue.title}</Text>}
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
      <Box width={keyWidth} flexShrink={0}><Text color={palette.muted}>Labels</Text></Box>
      <Box flexDirection="column" gap={pillRowGap}>
        {props.rows.map(row => (
          <Box gap={pillGap}>
            {row.map(label => <Text backgroundColor={palette.pill} color={palette.text}>{` ${label} `}</Text>)}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function drawMetaRow({ Box, Text }: PaneElements, row: FlowRow): RenderElement {
  return (
    <Box>
      <Box width={keyWidth} flexShrink={0}>
        <Text color={palette.muted}>{row.key}</Text>
      </Box>
      <Text color={toneColor[row.tone]} wrap="truncate-end">{row.value}</Text>
    </Box>
  )
}

function drawNoteRow({ Box, Text }: PaneElements, row: FlowRow): RenderElement {
  return (
    <Box>
      <Box width={keyWidth} flexShrink={0}>
        <Text color={toneColor[row.tone]} bold>{row.key}</Text>
      </Box>
      <Text color={palette.text} wrap="truncate-end">{row.value}</Text>
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
 * Draws the flow's steps, each with its state's mark, a stale marker, its hint and, indented under it, its sub-steps.
 *
 * @param elements - The element table.
 * @param props - The steps.
 * @returns The step list.
 */
export function drawStepList({ Box, Text }: PaneElements, props: StepListProps): RenderElement {
  const drawLine = (step: FlowStep | FlowSubStep): RenderElement => (
    <Text>
      <Text color={symbolColor[step.state]}>{step.symbol} </Text>
      <Text color={labelColor[step.state]} bold={step.state === 'current'}>{step.label}</Text>
      {step.isStale && <Text color={palette.warn}>{inlineGap}stale</Text>}
    </Text>
  )
  return (
    <Box flexDirection="column">
      {props.steps.map(step => (
        <Box flexDirection="column">
          {drawLine(step)}
          {step.hint && <Box paddingLeft={hintIndent}><Text color={palette.muted}>{step.hint}</Text></Box>}
          {step.subSteps.map(sub => (
            <Box paddingLeft={hintIndent} flexDirection="column">
              {drawLine(sub)}
              {sub.hint && <Box paddingLeft={hintIndent}><Text color={palette.muted}>{sub.hint}</Text></Box>}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/**
 * Draws the notes: overrides, blocked writes and a failed handoff.
 *
 * @param elements - The element table.
 * @param props - The rows.
 * @returns The notes.
 */
export function drawNotes(elements: PaneElements, props: KeyedRowsProps): RenderElement {
  return <elements.Box flexDirection="column">{props.rows.map(row => drawNoteRow(elements, row))}</elements.Box>
}

/**
 * Draws the rule, the footer's text and the button that continues in a new session.
 *
 * @param elements - The element table.
 * @param props - The footer, the body's width and what pressing the button does.
 * @returns The footer.
 */
export function drawFooter({ Box, Text, Button }: PaneElements, props: FooterProps): RenderElement {
  return (
    <Box flexDirection="column">
      <Text color={palette.pill}>{drawRule(props.columns)}</Text>
      <Box justifyContent="space-between">
        <Text color={palette.muted}>{props.footer.text ?? ''}</Text>
        <Button key="handoff" label="Continue in new session" variant="primary" hotkey="h" dimColor={props.footer.isRunning} onPress={props.startHandoff} />
      </Box>
    </Box>
  )
}
