import type { Next, NextResult, PaneCloseInput, RenderElement, RenderPropsOf } from 'claude-code'

import type { EnginePort } from '../core/engine-port'
import type { PaneView } from '../core/engine-port'
import { refreshView } from '../core/pane-view'
import { readRunLog } from '../core/run-view'
import { dismissViolations } from '../core/violation-store'
import { createFeaturePort } from '../core/feature-port'
import { startHandoff, startNewSession } from '../features/handoff'
import { openIssueInBrowser } from '../lib/github'
import { renderFlowPane } from '../ui/pane'
import type { PaneElements } from '../ui/pane-sections'
import { renderRunLog } from '../ui/run-log'

type PaneProps = Pick<RenderPropsOf['Pane'], 'bodyColumns' | 'scroll'>

/**
 * Changes the content drawn by the persistent Flow pane and resets its Escape behavior.
 * @param port - The engine calls.
 * @param paneView - The view to draw.
 * @param closeOnEscape - Whether Escape requests a person close.
 * @returns Once the view and pane options are updated.
 */
async function showPaneView(port: EnginePort, paneView: PaneView, closeOnEscape?: true): Promise<void> {
  await port.writePaneView(paneView)
  await port.openPane(closeOnEscape)
}

/**
 * Draws the Flow pane, ending quietly with an empty tree when the host abandons the render.
 *
 * @param port - The engine calls.
 * @param elements - The element table, from `$.ui.resolve(e)`.
 * @param props - The pane's props: its body's width and height.
 * @param signal - The render's dispatch signal, which aborts when a newer render supersedes it.
 * @returns The pane.
 */
export async function handlePaneRender(port: EnginePort, elements: PaneElements, props: PaneProps, signal: AbortSignal): Promise<RenderElement> {
  try { return await drawPane(port, elements, props) } catch (error) {
    // The host discards an abandoned render and cuts its `$` calls, so their rejection is not a failure.
    if (signal.aborted) return <elements.Box />
    throw error
  }
}

/**
 * Draws the Flow pane from the stored view, with issue buttons and the session action.
 *
 * @param port - The engine calls.
 * @param elements - The element table, from `$.ui.resolve(e)`.
 * @param props - The pane's props: its body's width and height.
 * @returns The pane.
 */
async function drawPane(port: EnginePort, elements: PaneElements, props: PaneProps): Promise<RenderElement> {
  const view = await port.readView()
  if (await port.readPaneView() === 'run-log') {
    return renderRunLog(elements, await readRunLog(port), view?.selectedRunId, props.bodyColumns, async selectedRunId => {
      const current = await port.readView()
      if (current) await port.writeView({ ...current, selectedRunId })
    }, () => { void showPaneView(port, 'flow') })
  }
  return renderFlowPane(elements, view, { columns: props.bodyColumns, rows: props.scroll.bodyRows }, {
    openIssue: async issueNumber => {
      await openIssueInBrowser(port.processes, issueNumber)
    },
    dismissViolations: async () => {
      await dismissViolations(port, (view?.violations ?? []).map(note => note.factId))
      await refreshView(port, true)
    },
    startNewSession: () => { if (!view?.footer?.isRunning) void startNewSession(createFeaturePort(port)) },
    startHandoff: () => { if (!view?.footer?.isRunning) void startHandoff(createFeaturePort(port)) },
    openRunLog: () => { void showPaneView(port, 'run-log', true) },
  })
}

/**
 * Turns a person close of the Run log view into a return to Flow.
 * @param port - The engine calls.
 * @param event - The pane close request.
 * @param next - The remaining close chain.
 * @returns Once the pane is restored or the close passes through.
 */
export async function handlePaneClose(port: EnginePort, event: PaneCloseInput, next: Next<'ui.close'>): Promise<NextResult<'ui.close'>> {
  if (event.origin.kind === 'person' && await port.readPaneView() === 'run-log') {
    await showPaneView(port, 'flow')
    return { value: undefined }
  }
  return next(event)
}
