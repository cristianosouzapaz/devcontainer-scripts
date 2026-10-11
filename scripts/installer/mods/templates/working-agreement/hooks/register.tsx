import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EnginePort } from './core/engine-port'
import { markForAgent } from './domain/messages'
import { setHandoffThreshold } from './features/handoff'
import { handleDeclareFlowCall } from './handlers/declare-flow'
import { handleFlowCommand } from './handlers/flow-command'
import { handlePaneRender } from './handlers/pane-render'
import { handleClassicPromptSubmit, handlePromptSubmit } from './handlers/prompt'
import { handleClassicSessionStart, handleSessionStart } from './handlers/session'
import { handleSkillPrompt } from './handlers/skill'
import { handleToolCall } from './handlers/tool-call'
import { handleToolCheck } from './handlers/tool-check'
import { handleClassicStop, handleTurnComplete } from './handlers/turn'

const paneId = 'working-agreement'
const declareTool = 'mcp__working-agreement__declare_flow'
const checkFailed = markForAgent('The check failed, so the call is denied — retry; if it keeps failing, stop and tell the user.')
const view = atom({ plugin: 'working-agreement', key: 'view' } as const, null)

// Builds the engine calls the core and the handlers make: `$` cannot be passed across an import, so every call on it stays written here.
function createEnginePort($: EngineInterface): EnginePort {
  return {
    processes: { run: (argv, options) => $.process.run(argv, options) },
    files: { read: path => $.fs.read(path), stat: path => $.fs.stat(path) },
    clock: { sleep: (delayMs, signal) => $.clock.sleep(delayMs, { signal }) },
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
    now: () => $.clock.now(),
    repeat: (delayMs, work) => { $.clock.every(delayMs, work) },
    defer: work => { $.clock.after(0, work) },
    readRepository: () => $.session.repo(),
    readCwd: () => $.session.cwd(),
    readHome: () => $.env.get('HOME'),
    readSessionId: () => $.session.id(),
    readContextTokens: async () => (await $.session.usage()).context.tokens ?? 0,
    readView: () => read($, view),
    writeView: async next => { await update($, view, () => next) },
    openPane: async () => { await $.ui.open({ id: paneId, title: 'Flow' }) },
    toast: text => { $.ui.toast(text) },
    runSlashCommand: async (command, args) => { await $.command.run(args === undefined ? { command } : { command, args }) },
    submitPrompt: async text => { await $.prompt.submit({ text, asUser: true }) },
    registerSurface: async () => {
      await $.command.register({
        name: 'flow',
        description: 'Working agreement: open the pane; status | handoff [cancel] | trivial | follow-up #n | override <step> [#n] <reason>',
        argumentHint: '[status|handoff [cancel]|trivial|follow-up #n|override <step> <reason>]',
      })
      await $.tool.register({
        name: 'declare_flow',
        description:
          'Declare the AGENTS.md flow of this session before its first flow step (grilling, to-spec, triage…) or the first write in the repository; ' +
          'when the session starts from an issue, read it and classify it. ' +
          'flow: large-feature | small-feature | fix | close-out. issues: the GitHub issue numbers this unit of work resolves ' +
          '(omit when the flow will create its issue: Small feature via /to-spec, Fix via /triage, Large feature via /to-tickets). ' +
          'If unsure which flow fits, ask the user with a multiple-choice question first. ' +
          'Trivial change and Follow-up are declared only by the user (/flow trivial, /flow follow-up #n): if a change looks trivial, tell the user and ask them to declare it.',
        inputSchema: {
          type: 'object',
          properties: {
            flow: { type: 'string', enum: ['large-feature', 'small-feature', 'fix', 'close-out'] },
            issues: { type: 'array', items: { type: 'integer' } },
          },
          required: ['flow'],
        },
      })
    },
  }
}

// The notice a prompt carries instead of the flow instruction when the flow state could not be read, with the cause.
function describeUnreadState(cause: string): string {
  return markForAgent(`The flow state could not be read (${cause}), so this prompt carries no flow instruction — if it keeps happening, stop and tell the user.`)
}

/**
 * Registers the hooks that enforce the working agreement's flows and draw the Flow pane.
 *
 * @param on - Adds a hook for an engine event.
 * @param options - The user's plugin configuration, read for the handoff threshold.
 */
export const register: Register = (on, options): void => {
  setHandoffThreshold(options.handoffTokens)

  on('session.start', ($, e, next) => handleSessionStart(createEnginePort($), e, next))

  on('classic.SessionStart', (_$, e, next) => handleClassicSessionStart(e, next))

  on('classic.UserPromptSubmit', (_$, e, next) => handleClassicPromptSubmit(e, next))

  // The read-only side fails open: a failed read submits the prompt with the notice instead of the flow line; a chain already called is passed through.
  on('prompt.submit', ($, e, next) => handlePromptSubmit(createEnginePort($), e, next))
    .catch((_$, e, next) => next.called ? next(e) : next({ ...e, context: [...(e.context ?? []), describeUnreadState(next.error.message ?? next.error.kind)] }))

  on('skill.prompt', ($, e, next) => handleSkillPrompt(createEnginePort($), e, next))

  on('turn.complete', ($, e, next) => handleTurnComplete(createEnginePort($), e, next))

  on('classic.Stop', ($, e, next) => handleClassicStop(createEnginePort($), e, next))

  on('tool.call', { tool: declareTool }, ($, e) => handleDeclareFlowCall(createEnginePort($), e)).catch(() => ({ deny: checkFailed }))

  // Its .catch also answers a call re-entered beneath the hook's own $ calls (next.called false): the check never ran on it, so it is denied.
  on('tool.call', ($, e, next) => handleToolCall(createEnginePort($), e, next)).catch((_$, e, next) => next.called ? next(e) : { deny: checkFailed })

  on('tool.check', ($, e, next) => handleToolCheck(createEnginePort($), e, next)).catch(() => ({ decision: 'deny', reason: checkFailed }))

  on('command.run', { command: 'flow' }, async ($, e) => ({ text: await handleFlowCommand(createEnginePort($), e) }))

  on('ui.render', { component: 'Pane', requestId: paneId }, ($, e) => handlePaneRender(createEnginePort($), $.ui.resolve(e), e.props))
}
