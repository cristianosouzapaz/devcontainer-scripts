import type { Next, NextResult, PaneCloseInput, RenderElement, RenderPropsOf } from 'claude-code'

import type { EnginePort } from '../core/engine-port'
import type { PaneView } from '../core/engine-port'
import { refreshView } from '../core/pane-view'
import { readRunLog } from '../core/run-view'
import { markShown } from '../core/start-notices'
import { dismissViolations } from '../core/violation-store'
import { createFeaturePort } from '../core/feature-port'
import { startHandoff, startNewSession } from '../features/handoff'
import { openIssueInBrowser } from '../lib/github'
import { renderFlowPane } from '../ui/pane'
import { readShownNotices } from '../ui/pane-layout'
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
  try {
    const drawn = await drawPane(port, elements, props)
    // why: a render the host did not abandon is what the pane shows, so only then are the notices it drew acknowledged, never when a view was merely stored, the pane closed or on Run log.
    if (!signal.aborted) markShown(drawn.notices)
    return drawn.element
  } catch (error) {
    // why: the host discards an abandoned render and cuts its `$` calls, so their rejection is not a failure.
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
 * @returns The pane, and the notices its Flow view drew, none for Run log.
 */
async function drawPane(port: EnginePort, elements: PaneElements, props: PaneProps): Promise<{ element: RenderElement; notices: string[] }> {
  const view = await port.readView()
  if (await port.readPaneView() === 'run-log') {
    return { notices: [], element: renderRunLog(elements, await readRunLog(port), view?.selectedRunId, props.bodyColumns, async selectedRunId => {
      await port.patchView(current => ({ ...current, selectedRunId }))
    }, () => { void showPaneView(port, 'flow') }) }
  }
  const liveRun = await port.readLiveRun()
  // why: only what the window certainly showed counts as drawn, never a note below it, one scrolled past, or one a live run may push down.
  const shown = view ? readShownNotices(view, props.bodyColumns, { offset: props.scroll.offset, rows: props.scroll.bodyRows }, !!liveRun) : []
  return { notices: shown, element: renderFlowPane(elements, view, liveRun, { columns: props.bodyColumns, rows: props.scroll.bodyRows }, {
    openIssue: async issueNumber => {
      const opened = await openIssueInBrowser(port.processes, issueNumber)
      if (opened.isOk) return
      await port.patchView(current => ({ ...current, openFailure: { issue: issueNumber, reason: opened.error, url: current.issues.find(issue => issue.number === issueNumber)?.url ?? '' } }))
    },
    dismissViolations: async () => {
      await dismissViolations(port, (view?.violations ?? []).map(note => note.factId))
      await refreshView(port, { isQuiet: true })
    },
    copyMerge: async surface => {
      // why: the copy waits on the host, so its outcome is set on the view published by then, never on the one read before it.
      const text = (await port.readView())?.notes.find(note => note.key === 'Merge')?.value
      if (!text) return
      const mergeCopy = await port.copy(text, surface)
      // why: a paint meanwhile may name another command, which was not the one copied, so only the same command is marked.
      await port.patchView(current => current.notes.find(note => note.key === 'Merge')?.value === text ? { ...current, mergeCopy } : current)
    },
    startNewSession: () => { if (!view?.footer?.isRunning) void startNewSession(createFeaturePort(port)) },
    startHandoff: () => { if (!view?.footer?.isRunning) void startHandoff(createFeaturePort(port)) },
    openRunLog: () => { void showPaneView(port, 'run-log', true) },
  }) }
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
