import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EnginePort } from './core/engine-port'
import { issueTools, readModulesAhead, suggestCoordinateTool, unitTools } from './domain/coordinator'
import { suggestDelegateTool } from './domain/delegation'
import { markForAgent, modToolPrefix } from './domain/messages'
import { sessionMemory } from './core/session-memory'
import { setSpawnLimit } from './core/spawn'
import { setHandoffThreshold } from './features/handoff'
import { denyCoordinatorCall, handleAgentSpawn, handleMergeChildCall, handleSuggestCall, handleSuggestDelegateCall, handleToolCheck } from './handlers/coordinator'
import { handleDeclareFlowCall } from './handlers/declare-flow'
import { handleFlowCommand } from './handlers/flow-command'
import { handleIssueCall } from './handlers/issues'
import { handlePaneClose, handlePaneRender } from './handlers/pane-render'
import { handlePromptSubmit } from './handlers/prompt'
import { handleClassicSessionStart, handleFileChanged, handleSessionStart } from './handlers/session'
import { handleSkillPrompt } from './handlers/skill'
import { handleToolCall } from './handlers/tool-call'
import { handleRun } from './handlers/run'
import { handleVerify } from './handlers/verify'
import { handleTurnComplete } from './handlers/turn'
import { handleUnitCall } from './handlers/units'
import { handleStop, handleWorktreeCreate, handleWorktreeRemove } from './handlers/worktree'
import { runWithDeadline } from './lib/process'

const paneId = 'working-agreement'
const issueNumber = { type: 'integer', minimum: 1 }
const issueFields = {
  title: { type: 'string', minLength: 1, description: 'Conventional-Commit style "type(scope): summary" unless issues.title says otherwise; issues with a wayfinder:* label are exempt.' },
  kind: { type: 'string', description: 'Which configured sections the body needs: spec, ticket, bug, decision, or a kind from issues.sections.' },
  sections: { type: 'object', additionalProperties: { type: 'string', minLength: 1 }, description: 'The body: each heading mapped to its markdown, in order; the kind\'s sections are required.' },
  type: { type: 'string', description: 'Sets the type::<type> label (and the native type when GitHub has it); required when issues.types is configured.' },
  priority: { type: 'string', description: 'Sets the priority::<priority> label; required when issues.priorities is configured.' },
  triage: { type: 'string', enum: ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'] },
  labels: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Other labels to add, e.g. wayfinder:map.' },
  assignees: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Logins to assign; @me by default on create.' },
  milestone: { type: 'string', minLength: 1 },
  project: { type: 'string', minLength: 1, description: 'A Projects v2 title.' },
  parent: { ...issueNumber, description: 'Makes the issue a native sub-issue of this one.' },
  blockedBy: { type: 'array', items: issueNumber, description: 'Native blocked-by dependencies to add.' },
}
const declareTool = `${modToolPrefix}declare_flow`
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
    processes: { spawn: request => $.process.spawn(request), run: (argv, options) => runWithDeadline((line, init) => $.process.run(line, init), () => $.clock.now(), argv, options) },
    files: { stat: path => $.fs.stat(path, { resolve: true }), exists: path => $.fs.exists(path), read: path => $.fs.read(path), write: (path, text) => $.fs.write(path, text), list: path => $.fs.list(path) },
    clock: { sleep: (delayMs, signal) => $.clock.sleep(delayMs, { signal }) },
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
        description: 'Working agreement: open the pane; status | report | coordinate | delegate [#n …|stop] | setup-labels | handoff [cancel] | trivial | follow-up #n | skip <step> <reason> | approve <comment-url> | approve verify [id]',
        argumentHint: '[status|report|coordinate|delegate [#n …|stop]|setup-labels|handoff [cancel]|trivial|follow-up #n|skip <step> <reason>|approve <comment-url>|approve verify [id]]',
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
            issues: { type: 'array', items: issueNumber },
          },
          required: ['flow'],
        },
      })
      await $.tool.register({
        name: 'suggest_coordinate',
        isDeferred: false,
        description: 'When the user asks for a manager or coordinator session, pre-fills /flow coordinate in their prompt box. ' +
          'The role is set only when the user submits it; a coordinator never writes in the repository.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      })
      await $.tool.register({
        name: 'suggest_delegate',
        isDeferred: false,
        description: 'When the user says they delegate, pre-fills /flow delegate with the issues they named (none: the issues this coordinator creates) in their prompt box. ' +
          'Coordinator only; nothing is delegated until the user submits it.',
        inputSchema: { type: 'object', properties: { issues: { type: 'array', items: issueNumber } }, additionalProperties: false },
      })
      await $.tool.register({
        name: 'merge_child',
        isDeferred: false,
        description: 'Coordinator only, under delegation: merges a finished child unit\'s branch into the parent branch it was cut from — fast-forward when the parent has not moved, '
          + 'else --no-ff when it merges cleanly, aborted on conflict — and records it as delegated. Refused for a pair the mod does not know; a merge into the default branch is always the user\'s.',
        inputSchema: { type: 'object', properties: { child: { type: 'string', minLength: 1 } }, required: ['child'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'issue_create',
        isDeferred: false,
        description: 'The only way to create a GitHub issue (raw gh issue/label writes are denied): checks title, body sections, triage label, type, priority and assignee ' +
          'against .claude/working-agreement.json and the live labels, sets parent and blocked-by natively, and reads the issue back.',
        inputSchema: { type: 'object', properties: issueFields, required: ['title', 'kind', 'sections', 'triage'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'issue_edit',
        isDeferred: false,
        description: 'The only way to edit a GitHub issue: replaces title or body (kind with sections), swaps the triage, type or priority label, adds labels, assignees, ' +
          'parent and blocked-by, or reopens (state: open); the issue must still carry every required field.',
        inputSchema: { type: 'object', properties: { number: issueNumber, ...issueFields, state: { type: 'string', enum: ['open'] } }, required: ['number'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'issue_close',
        isDeferred: false,
        description: 'The only way to close a GitHub issue, with its state reason and an optional closing comment; reads the issue back.',
        inputSchema: { type: 'object', properties: { number: issueNumber, reason: { type: 'string', enum: ['completed', 'not planned', 'duplicate'] },
          duplicateOf: issueNumber, comment: { type: 'string', minLength: 1 } }, required: ['number', 'reason'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'issue_comment',
        isDeferred: false,
        description: 'The only way to comment on a GitHub issue of this repository; a coordinator\'s GitHub write channel. ' +
          'A body whose first line is "## Delegated decision" must carry ### Question, ### Alternatives considered, ### Choice, ### Reason, ### Cost of going back (low, medium or high), ' +
          'and puts the delegated-review label on the issue. The user reviews each decision with a body whose first line is "## Delegated review", carrying ' +
          '### Decision (the decision comment\'s URL) and ### Outcome (confirmed, follow-up #<issue> or fix #<issue>); the review of the last unreviewed decision removes the label. A review is refused from the coordinator, a delegated unit, or a session whose delegation scope cannot be read.',
        inputSchema: { type: 'object', properties: { number: issueNumber, body: { type: 'string', minLength: 1 } }, required: ['number', 'body'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'spawn',
        isDeferred: false,
        description: 'Coordinator only: starts the unit session of an issue in its own herdr worktree on branch <n>-<title slug>, from the default branch, ' +
          'or from the branch of the open issue blocking it once that branch has a commit. Idempotent: a live session is reused, ' +
          'a worktree without one is reopened and its session resumed. Refused beyond the configured cap of concurrent units.',
        inputSchema: { type: 'object', properties: { number: issueNumber }, required: ['number'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'unit_prompt',
        isDeferred: false,
        description: 'Coordinator only: sends a message to the unit session of an issue, such as the answer to its question.',
        inputSchema: { type: 'object', properties: { number: issueNumber, text: { type: 'string', minLength: 1 } }, required: ['number', 'text'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'unit_read',
        isDeferred: false,
        description: "Coordinator only: reads the recent terminal output of an issue's unit session.",
        inputSchema: { type: 'object', properties: { number: issueNumber, lines: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['number'], additionalProperties: false },
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
  setSpawnLimit(options.spawnLimit)

  on('engine.create', (_$, e, next) => {
    sessionMemory.modulesAhead = readModulesAhead(e.plugins, sessionMemory.modulesAhead)
    return next(e)
  })

  on('session.start', ($, e, next) => handleSessionStart(createEnginePort($, 'session start'), e, next))

  on('classic.SessionStart', ($, e, next) => handleClassicSessionStart(createEnginePort($, 'session start'), e, next))

  on('classic.FileChanged', ($, e, next) => handleFileChanged(createEnginePort($, 'ref change'), e, next))

  on('classic.WorktreeCreate', ($, e, next) => handleWorktreeCreate(createEnginePort($, 'worktree create'), e, next))

  on('classic.WorktreeRemove', ($, e, next) => handleWorktreeRemove(createEnginePort($, 'worktree remove'), e, next))

  on('classic.Stop', ($, e, next) => handleStop(createEnginePort($, 'stop'), e, next))

  // The read-only side fails open: a failed read submits the prompt with the notice instead of the flow line; a chain already called is passed through.
  on('prompt.submit', ($, e, next) => handlePromptSubmit(createEnginePort($, 'prompt'), e, next))
    .catch((_$, e, next) => next.called ? next(e) : next({ ...e, context: [...(e.context ?? []), describeUnreadState(next.error.message ?? next.error.kind)] }))

  on('skill.prompt', ($, e, next) => handleSkillPrompt(createEnginePort($, `skill ${e.skill}`), e, next))

  on('turn.complete', ($, e, next) => handleTurnComplete(createEnginePort($, 'turn end'), e, next))

  // A coordinator never declares a flow; this hook answers without next, so the guard runs inside it.
  on('tool.call', { tool: declareTool }, async ($, e) => {
    const port = createEnginePort($, 'declare_flow')
    const deny = await denyCoordinatorCall(port, e)
    return deny ? { deny } : handleDeclareFlowCall(port, e)
  }).catch((_$, _e, next) => ({ deny: `${checkFailed} ${next.error.message ?? next.error.kind}` }))

  // Registration order nests hooks: the window must precede Verify and Run, which answer without next.
  // Its .catch also answers a call re-entered beneath the hook's own $ calls (next.called false): the check never ran on it, so it is denied.
  on('tool.call', ($, e, next) => handleToolCall(createEnginePort($, `tool ${e.tool}`), e, next)).catch((_$, e, next) => next.called ? next(e) : { deny: checkFailed })

  on('tool.call', { tool: `${modToolPrefix}verify` }, ($, _e, next) => handleVerify(createEnginePort($, 'verify'), next.signal))
    .catch((_$, _e, next) => ({ result: markForAgent(`Verify could not run: ${next.error.message ?? next.error.kind}`), isError: true }))

  on('tool.call', { tool: `${modToolPrefix}run` }, ($, e, next) => handleRun(createEnginePort($, 'run'), { argv: e.argv }, next.signal))
    .catch((_$, _e, next) => ({ result: markForAgent(`Run could not run: ${next.error.message ?? next.error.kind}`), isError: true }))

  on('tool.call', { tool: suggestCoordinateTool }, $ => handleSuggestCall(createEnginePort($, 'suggest coordinate')))
    .catch((_$, _e, next) => ({ result: markForAgent(`The suggestion was not shown: ${next.error.message ?? next.error.kind}`), isError: true }))

  on('tool.call', { tool: suggestDelegateTool }, ($, e) => handleSuggestDelegateCall(createEnginePort($, 'suggest delegate'), e))
    .catch((_$, _e, next) => ({ result: markForAgent(`The suggestion was not shown: ${next.error.message ?? next.error.kind}`), isError: true }))

  on('tool.call', { tool: `${modToolPrefix}merge_child` }, ($, e) => handleMergeChildCall(createEnginePort($, 'merge child'), e))
    .catch((_$, _e, next) => ({ result: markForAgent(`merge_child could not run, so check the parent branch before anything else: ${next.error.message ?? next.error.kind}`), isError: true }))

  for (const tool of issueTools) {
    on('tool.call', { tool: `${modToolPrefix}${tool}` }, ($, e) => handleIssueCall(createEnginePort($, tool), tool, e))
      .catch((_$, _e, next) => ({ result: markForAgent(`${tool} could not run, so nothing is confirmed written: ${next.error.message ?? next.error.kind}`), isError: true }))
  }

  for (const tool of unitTools) {
    on('tool.call', { tool: `${modToolPrefix}${tool}` }, ($, e) => handleUnitCall(createEnginePort($, tool), tool, e))
      .catch((_$, _e, next) => ({ result: markForAgent(`${tool} failed: ${next.error.message ?? next.error.kind}`), isError: true }))
  }

  // A coordinator's role must hold in every loop; a check that cannot read the role denies.
  on('tool.check', ($, e, next) => handleToolCheck(createEnginePort($, `check ${e.tool}`), e, next))
    .catch(() => ({ decision: 'deny', reason: checkFailed }))

  on('agent.spawn', ($, e, next) => handleAgentSpawn(createEnginePort($, 'agent spawn'), e, next))
    .catch(() => ({ deny: checkFailed }))

  on('command.run', { command: 'flow' }, async ($, e) => ({ text: await handleFlowCommand(createEnginePort($, `/flow ${e.args.trim().split(/\s+/)[0] ?? ''}`.trim()), e) }))

  on('ui.render', { component: 'Pane', requestId: paneId }, ($, e, next) => handlePaneRender(createEnginePort($, 'pane'), $.ui.resolve(e), e.props, next.signal))
  on('ui.close', { id: paneId }, ($, e, next) => handlePaneClose(createEnginePort($, 'pane close'), e, next))
}
