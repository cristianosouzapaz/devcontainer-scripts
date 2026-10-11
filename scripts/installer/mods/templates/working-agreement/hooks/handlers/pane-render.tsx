import type { RenderElement, RenderPropsOf } from 'claude-code'

import type { EnginePort } from '../core/engine-port'
import { createFeaturePort } from '../core/feature-port'
import { startHandoff } from '../features/handoff'
import { openIssueInBrowser } from '../lib/github'
import { renderFlowPane } from '../ui/pane'
import type { PaneElements } from '../ui/pane-sections'

/**
 * Draws the Flow pane from the stored view, with buttons that open an issue and continue in a new session.
 *
 * @param port - The engine calls.
 * @param elements - The element table, from `$.ui.resolve(e)`.
 * @param props - The pane's props: its body's width and height.
 * @returns The pane.
 */
export async function handlePaneRender(port: EnginePort, elements: PaneElements, props: Pick<RenderPropsOf['Pane'], 'bodyColumns' | 'scroll'>): Promise<RenderElement> {
  const view = await port.readView()
  return renderFlowPane(elements, view, { columns: props.bodyColumns, rows: props.scroll.bodyRows }, {
    openIssue: async issueNumber => {
      const opened = await openIssueInBrowser(port.processes, issueNumber)
      if (!opened.isOk) port.toast(`Could not open #${issueNumber} (${opened.error}).`)
    },
    startHandoff: () => { if (!view?.footer?.isRunning) void startHandoff(createFeaturePort(port)) },
  })
}
