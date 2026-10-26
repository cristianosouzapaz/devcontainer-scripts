import type { RenderElement } from 'claude-code'

import type { FlowView, RunView } from '../../types'
import { layoutLabelRows, measureLabelWidth } from './pane-layout'
import { drawFooter, drawHeader, drawIssueList, drawLabelRows, drawMetaRows, drawNotes, drawStepList } from './pane-sections'
import type { PaneElements } from './pane-sections'
import { keyWidth, panePadding, sectionGap } from './theme'
import { drawLiveRun } from './run-log'

/** What the pane's buttons do. */
interface PaneActions {
  openIssue: (issueNumber: number) => void
  startHandoff: () => void
  startNewSession: () => void
  dismissViolations: () => void
  openRunLog: () => void
}

/** The body's width and height, in characters. */
interface PaneLayout {
  columns: number
  rows: number
}

/**
 * Draws the Flow pane: its sections, one blank row between them.
 *
 * @param elements - The element table.
 * @param view - What the pane shows, or null with no flow declared.
 * @param run - The run in flight, drawn under its step, or null.
 * @param layout - The body's width and height, in characters.
 * @param actions - What the pane's buttons do.
 * @returns The pane.
 */
export function renderFlowPane(elements: PaneElements, view: FlowView | null, run: RunView | null, layout: PaneLayout, actions: PaneActions): RenderElement {
  const { Box, Text, Button } = elements
  const fill = { width: layout.columns, minHeight: layout.rows, paddingX: panePadding.x, paddingTop: panePadding.top }
  if (!view) return <Box {...fill}><Text color="inactive">No flow declared.</Text></Box>
  const labelRows = layoutLabelRows(view.labels, measureLabelWidth(layout.columns))
  const notes = [...view.notes, ...(view.violations ?? []).map(note => ({ key: note.tone === 'warn' ? 'Unchecked' : 'Violation', value: note.text, tone: note.tone }))]
  const sections = [
    drawHeader(elements, { flow: view.flow, progress: view.progress, columns: layout.columns }),
    (view.pending || view.issues.length > 0) && drawIssueList(elements, { pending: view.pending, issues: view.issues, openIssue: actions.openIssue }),
    labelRows.length > 0 && drawLabelRows(elements, { rows: labelRows }),
    view.meta.length > 0 && drawMetaRows(elements, { rows: view.meta }),
    drawStepList(elements, { steps: view.steps, run: run ?? undefined }),
    run && drawLiveRun(elements, run),
    notes.length > 0 && <Box flexDirection="column">
      {drawNotes(elements, { rows: notes })}
      {(view.violations?.length ?? 0) > 0 && <Box marginTop={1} paddingLeft={keyWidth}><Box flexShrink={0}><Button key="dismiss" label="dismiss" hotkey="d" onPress={actions.dismissViolations} /></Box></Box>}
    </Box>,
    (view.footer || view.hasRunLog) && drawFooter(elements, { footer: view.footer, hasRunLog: view.hasRunLog, openRunLog: actions.openRunLog, columns: layout.columns, startHandoff: actions.startHandoff, startNewSession: actions.startNewSession }),
  ].filter(section => !!section)
  return <Box flexDirection="column" gap={sectionGap} {...fill}>{sections}</Box>
}
