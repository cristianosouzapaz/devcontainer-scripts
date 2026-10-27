import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EnginePort } from './core/engine-port'
import { markForAgent } from './domain/messages'
import { setHandoffThreshold } from './features/handoff'
import { handleDeclareFlowCall } from './handlers/declare-flow'
import { handleFlowCommand } from './handlers/flow-command'
import { handlePaneClose, handlePaneRender } from './handlers/pane-render'
import { handlePromptSubmit } from './handlers/prompt'
import { handleClassicSessionStart, handleFileChanged, handleSessionStart } from './handlers/session'
import { handleSkillPrompt } from './handlers/skill'
import { handleToolCall } from './handlers/tool-call'
import { handleRun } from './handlers/run'
import { handleVerify } from './handlers/verify'
import { handleTurnComplete } from './handlers/turn'

const paneId = 'working-agreement'
const declareTool = 'mcp__working-agreement__declare_flow'
const checkFailed = markForAgent('The check failed, so the call is denied — retry; if it keeps failing, stop and tell the user.')
const session = { plugin: 'working-agreement', key: 'session' } as const
const view = atom({ plugin: 'working-agreement', key: 'view' } as const, null)
const liveRun = atom({ plugin: 'working-agreement', key: 'liveRun' } as const, null)
const paneView = atom({ plugin: 'working-agreement', key: 'paneView' } as const, 'flow')

/**
 * Builds the engine port as closures over `$`, which cannot be passed across an import.
 * @param $ - The hook's engine interface.
 * @param cause - The engine event the hook answers.
 * @returns The engine operations used by the core and handlers.
 */
function createEnginePort($: EngineInterface, cause: string): EnginePort {
  return {
    cause,
    processes: { spawn: request => $.process.spawn(request), run: (argv, options) => $.process.run(argv, options) },
    files: { stat: path => $.fs.stat(path, { resolve: true }), exists: path => $.fs.exists(path), read: path => $.fs.read(path), write: (path, text) => $.fs.write(path, text), list: path => $.fs.list(path) },
    clock: { sleep: (delayMs, signal) => $.clock.sleep(delayMs, { signal }) },
    clearLegacyStore: async () => { for (const key of await $.store.keys()) await $.store.delete(key) },
    readSessionState: () => $.state.get(session),
    writeSessionState: async (value, version) => (await $.state.set(session, value, { ifVersion: version })).isSet,
    logDebug: text => { $.ui.log(text, { to: 'debug' }) },
    now: () => $.clock.now(),
    repeat: (delayMs, work) => { $.clock.every(delayMs, work) },
    defer: work => { $.clock.after(0, work) },
    readHerdrEnv: async () => ({ environment: await $.env.get('HERDR_ENV'), paneId: await $.env.get('HERDR_PANE_ID') }),
    readCwd: () => $.session.cwd(),
    readPluginRoot: async () => $.plugin.root,
    readSessionId: () => $.session.id(),
    readContext: async () => (await $.session.usage({ breakdown: 'summary' })).context,
    readView: () => read($, view),
    writeView: async next => { await update($, view, () => next) },
    readLiveRun: () => read($, liveRun),
    writeLiveRun: async next => { await update($, liveRun, () => next) },
    readPaneView: () => read($, paneView),
    writePaneView: async next => { await update($, paneView, () => next) },
    openPane: async closeOnEscape => { await $.ui.open(closeOnEscape ? { id: paneId, title: 'Flow', closeOnEscape } : { id: paneId, title: 'Flow' }) },
    runSlashCommand: async (command, args) => { await $.command.run(args === undefined ? { command } : { command, args }) },
    submitPrompt: async text => { await $.prompt.submit({ text, asUser: true }) },
    suggestPrompt: async text => (await $.prompt.suggest({ text })).isShown,
    registerSurface: async () => {
      await $.command.register({
        name: 'flow',
        description: 'Working agreement: open the pane; status | handoff [cancel] | trivial | follow-up #n | skip <step> <reason> | approve <comment-url> | approve verify [id]',
        argumentHint: '[status|handoff [cancel]|trivial|follow-up #n|skip <step> <reason>|approve <comment-url>|approve verify [id]]',
      })
      await $.tool.register({
        name: 'run',
        isDeferred: false,
        description: 'Runs an argv for Diagnose, recording red/green evidence. Red/green runs made through Bash never count.',
        inputSchema: {
          type: 'object', properties: { argv: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } },
          required: ['argv'], additionalProperties: false,
        },
      })
      await $.tool.register({
        name: 'verify',
        isDeferred: false,
        description: "Runs commands selected from .claude/working-agreement.json for the unit's change. Verify counts only through this tool.",
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      })
      await $.tool.register({
        name: 'declare_flow',
        isDeferred: false,
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

/**
 * Creates the prompt notice used when flow state cannot be read.
 * @param cause - The read failure.
 * @returns The notice for the agent.
 */
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

  on('session.start', ($, e, next) => handleSessionStart(createEnginePort($, 'session start'), e, next))

  on('classic.SessionStart', ($, e, next) => handleClassicSessionStart(createEnginePort($, 'session start'), e, next))

  on('classic.FileChanged', ($, e, next) => handleFileChanged(createEnginePort($, 'ref change'), e, next))

  // The read-only side fails open: a failed read submits the prompt with the notice instead of the flow line; a chain already called is passed through.
  on('prompt.submit', ($, e, next) => handlePromptSubmit(createEnginePort($, 'prompt'), e, next))
    .catch((_$, e, next) => next.called ? next(e) : next({ ...e, context: [...(e.context ?? []), describeUnreadState(next.error.message ?? next.error.kind)] }))

  on('skill.prompt', ($, e, next) => handleSkillPrompt(createEnginePort($, `skill ${e.skill}`), e, next))

  on('turn.complete', ($, e, next) => handleTurnComplete(createEnginePort($, 'turn end'), e, next))

  on('tool.call', { tool: declareTool }, ($, e) => handleDeclareFlowCall(createEnginePort($, 'declare_flow'), e)).catch((_$, _e, next) => ({ deny: `${checkFailed} ${next.error.message ?? next.error.kind}` }))

  // Registration order nests hooks: the window must precede Verify and Run, which answer without next.
  // Its .catch also answers a call re-entered beneath the hook's own $ calls (next.called false): the check never ran on it, so it is denied.
  on('tool.call', ($, e, next) => handleToolCall(createEnginePort($, `tool ${e.tool}`), e, next)).catch((_$, e, next) => next.called ? next(e) : { deny: checkFailed })

  on('tool.call', { tool: 'mcp__working-agreement__verify' }, ($, _e, next) => handleVerify(createEnginePort($, 'verify'), next.signal))
    .catch((_$, _e, next) => ({ result: `Verify could not run: ${next.error.message ?? next.error.kind}` }))

  on('tool.call', { tool: 'mcp__working-agreement__run' }, ($, e, next) => handleRun(createEnginePort($, 'run'), { argv: e.argv }, next.signal))
    .catch((_$, _e, next) => ({ result: `Run could not run: ${next.error.message ?? next.error.kind}` }))

  on('command.run', { command: 'flow' }, async ($, e) => ({ text: await handleFlowCommand(createEnginePort($, `/flow ${e.args.trim().split(/\s+/)[0] ?? ''}`.trim()), e) }))

  on('ui.render', { component: 'Pane', requestId: paneId }, ($, e, next) => handlePaneRender(createEnginePort($, 'pane'), $.ui.resolve(e), e.props, next.signal))
  on('ui.close', { id: paneId }, ($, e, next) => handlePaneClose(createEnginePort($, 'pane close'), e, next))
}
