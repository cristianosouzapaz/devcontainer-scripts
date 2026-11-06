import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EnginePort } from './core/engine-port'
import { issueTools, readModulesAhead, suggestCoordinateTool, unitTools } from './domain/coordinator'
import { suggestDelegateTool } from './domain/delegation'
import { closeReasons, triageLabels } from './domain/issue-fields'
import { answerTool, describeHookError, failedToolAnswer, markForAgent, modToolPrefix } from './domain/messages'
import { sessionMemory } from './core/session-memory'
import { efforts, setContinueAtUsageLimit, setSpawnLimit } from './core/spawn'
import { setHandoffThreshold } from './features/handoff'
import { commitDelegated } from './core/delegated-commits'
import { mergeParent } from './core/parent-merge'
import { sendTyped } from './core/mail-send'
import { sendKinds } from './domain/mail-reply'
import { denyCoordinatorCall, handleAgentSpawn, handleMergeChildCall, handlePlanCall, handleSuggestCall, handleSuggestDelegateCall, handleToolCheck } from './handlers/coordinator'
import { handleDeclareFlowCall } from './handlers/declare-flow'
import { handleFlowCommand } from './handlers/flow-command'
import { handleIssueCall } from './handlers/issues'
import { handleMailPromptSubmit } from './handlers/mail'
import { handlePaneClose, handlePaneRender } from './handlers/pane-render'
import { handlePromptSubmit } from './handlers/prompt'
import { handleClassicSessionStart, handleFileChanged, handleSessionStart } from './handlers/session'
import { handleSkillPrompt } from './handlers/skill'
import { handleToolCall } from './handlers/tool-call'
import { handleRun } from './handlers/run'
import { handleVerify } from './handlers/verify'
import { handleNotification, handleTurnComplete, handleTurnStart } from './handlers/turn'
import { handleUnitCall } from './handlers/units'
import { handleStop, handleWorktreeCreate, handleWorktreeRemove } from './handlers/worktree'
import { runWithDeadline } from './lib/process'
import { checkFailed, guardCatch, measureGuard } from './core/check-retry'
import { reportGuardTimeout, reportGuardUsage } from './core/guard-log'

const paneId = 'working-agreement'
const issueNumber = { type: 'integer', minimum: 1 }
const issueFields = {
  title: { type: 'string', minLength: 1, description: 'Conventional-Commit style "type(scope): summary" unless issues.title says otherwise; issues with a wayfinder:* label are exempt.' },
  kind: { type: 'string', description: 'Which configured sections the body needs: spec, ticket, bug, decision, or a kind from issues.sections.' },
  sections: { type: 'object', additionalProperties: { type: 'string', minLength: 1 }, description: 'The body: each heading mapped to its markdown, in order; the kind\'s sections are required.' },
  type: { type: 'string', description: 'Sets the type::<type> label (and the native type when GitHub has it); required when issues.types is configured.' },
  priority: { type: 'string', description: 'Sets the priority::<priority> label; required when issues.priorities is configured.' },
  triage: { type: 'string', enum: triageLabels },
  labels: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Other labels to add, e.g. wayfinder:map.' },
  assignees: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Logins to assign; @me by default on create.' },
  milestone: { type: 'string', minLength: 1 },
  project: { type: 'string', minLength: 1, description: 'A Projects v2 title.' },
  parent: { ...issueNumber, description: 'Makes the issue a native sub-issue of this one.' },
  blockedBy: { type: 'array', items: issueNumber, description: 'Native blocked-by dependencies to add.' },
}
const declareTool = `${modToolPrefix}declare_flow`
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
    readHerdrEnv: async () => ({ environment: await $.env.get('HERDR_ENV'), paneId: await $.env.get('HERDR_PANE_ID'), socketPath: await $.env.get('HERDR_SOCKET_PATH') }),
    readCwd: () => $.session.cwd(),
    readClaudeDir: async () => {
      const home = await $.env.get('HOME')
      return await $.env.get('CLAUDE_CONFIG_DIR') ?? (home ? `${home}/.claude` : undefined)
    },
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
    copy: (text, surface) => $.ui.copy({ text, surface }),
    runSlashCommand: async (command, args) => { await $.command.run(args === undefined ? { command } : { command, args }) },
    // why: a prompt the engine refuses is otherwise lost without a trace, so its reason reaches the caller's failure log.
    submitPrompt: async text => {
      const entered = await $.prompt.submit({ text, asUser: true })
      if (entered.drop !== undefined) throw new Error(`the engine dropped the prompt: ${entered.drop}`)
    },
    notify: async text => { await $.ui.notify(text, { title: 'working-agreement' }) },
    toast: text => { $.ui.toast(text) },
    suggestPrompt: async text => (await $.prompt.suggest({ text })).isShown,
    registerSurface: async () => {
      await $.command.register({
        name: 'flow',
        description: 'Working agreement: open the pane; status | report | inbox [answer <id> <letter|no> [words]] | coordinate | delegate [#n …|triage #n …|stop] | retire #n [id] | setup-labels | handoff [cancel] | trivial | follow-up #n | skip <step> <reason> | lift | approve <comment-url> | approve verify (shows the config and its terminal approval command)',
        argumentHint: '[status|report|inbox [answer <id> <letter|no> [words]]|coordinate|delegate [#n …|triage #n …|stop]|retire #n [id]|setup-labels|handoff [cancel]|trivial|follow-up #n|skip <step> <reason>|lift|approve <comment-url>|approve verify [id]]',
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
        description: 'Coordinator only, under delegation: merges finished child units\' branches (child, or children: up to 3 sharing one parent, stacked in order) into the parent branch they were cut from — '
          + 'each child onto the commit below it by fast-forward when that commit is on the child\'s first-parent chain, else by a merge commit, refused on conflict — '
          + 'moving the parent only after Verify passes on that exact tree through the Verify queue (a gate pass already recorded on that tree, config and commands counts; a unit\'s own pass does not). One Verify gates the whole stack; '
          + 'a red one is bisected by prefix: the parent moves to the longest green prefix, and the culprit is named with the failing command, its output tail and its log, '
          + 'for the coordinator to relay to that child\'s unit. Records the merges as delegated. Refused for a pair the mod does not know; a merge into the default branch is always the user\'s.',
        inputSchema: { type: 'object', properties: {
          child: { type: 'string', minLength: 1 },
          children: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 3, uniqueItems: true },
        }, additionalProperties: false },
      })
      await $.tool.register({
        name: 'commit',
        isDeferred: false,
        description: 'Delegated unit only: commits the staged work (stage it with git add first) unsigned on the unit\'s own branch checked out here, '
          + 'and records it as delegated; Bash git commit is refused in a delegated unit. Never pushes.',
        inputSchema: { type: 'object', properties: { message: { type: 'string', minLength: 1 } }, required: ['message'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'merge_parent',
        isDeferred: false,
        description: 'Delegated unit only, when the coordinator asks for it: merges the parent branch\'s current tip into the unit\'s own branch checked out clean here, '
          + 'unsigned and recorded as delegated, so merge_child then merges the child cleanly; on a conflict it names the paths and leaves the merge in progress: '
          + 'resolve, git add, then conclude it with the commit tool. Run Verify on the merged tree. Never rebases or pushes.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
        inputSchema: { type: 'object', properties: { number: issueNumber, reason: { type: 'string', enum: closeReasons },
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
        description: 'Coordinator only: starts the unit session of an issue in its own herdr worktree on branch <type>/<n>-<title slug> (<n>-<title slug> without a Conventional Commit prefix), ' +
          'from the default branch, or from the branch of its one open blocker once that blocker\'s unit is finished or integrated; a sub-issue of an issue with a unit branch starts from that branch\'s tip, ' +
          'its parent issue never waited on as a blocker. Idempotent: a live session is reused, ' +
          'a worktree without one is reopened and its session resumed. Refused beyond the configured cap of concurrent units. ' +
          'instructions: the unit-specific rules, appended verbatim to the start prompt so its first turn starts with them; a unit already prompted does not get them. ' +
          'model and effort: your own judgement of what this unit needs, with a one-line reason; omit both for the user\'s default model and effort, which is also the strong choice. ' +
          'Pick a cheaper model or a lower effort only for work that is fully specified and routine; anything with open design questions or security weight keeps the defaults. ' +
          'The choice is recorded, shown in plan, and kept on every resume; a unit that fails Verify twice in a row is escalated by the mod to the user\'s default model with effort high.',
        inputSchema: { type: 'object', properties: { number: issueNumber, instructions: { type: 'string' },
          model: { type: 'string', minLength: 1, description: 'A model name or alias the claude CLI accepts; checked before anything starts.' },
          effort: { type: 'string', enum: [...efforts] },
          reason: { type: 'string', minLength: 1, description: 'One line: why this unit gets that model or effort. Required with either.' } },
        required: ['number'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'escalate_unit',
        isDeferred: false,
        description: 'Coordinator only, under delegation: raises a unit spawned on a cheaper model or lower effort to the user\'s default model with effort high, keeping its whole '
          + 'conversation: the mod closes its idle session and resumes it, records the new level and says so. A unit that works is escalated once it is idle, never mid-turn. '
          + 'Use it when the unit meets a need its level was not picked for, such as an unexpected design decision; routine decisions do not call for it.',
        inputSchema: { type: 'object', properties: { number: issueNumber, reason: { type: 'string', minLength: 1, description: 'Why the unit needs more capability.' } },
          required: ['number', 'reason'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'dismiss_dialog',
        isDeferred: false,
        description: 'Coordinator only: clears the dialog a stall report named in a unit\'s pane by sending Esc, the only key the mod ever sends. Refused unless the report '
          + 'named that dialog, the dialog catalogue allows Esc on it, and the pane, read again just before acting, still shows it. Never sent to a dialog whose Esc has a '
          + 'side effect, such as the auto-mode setup offer, nor to one the catalogue does not know: those are the user\'s to answer in the unit\'s pane.',
        inputSchema: { type: 'object', properties: { number: issueNumber,
          dialog: { type: 'string', minLength: 1, description: 'The dialog\'s catalogue id, as the stall report names it.' },
          key: { type: 'string', enum: ['Escape'], description: 'The key to send; Escape is the only one, and the default.' } },
        required: ['number', 'dialog'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'plan',
        isDeferred: false,
        description: 'Coordinator only, read-only: for each delegated issue lists its open blockers and their unit states (none, working, finished, integrated), '
          + 'its own unit state, its unit\'s model, effort and reason, and whether spawn would start it now and from which branch, by spawn\'s own rules; issues that can start now come first.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      })
      await $.tool.register({
        name: 'unit_prompt',
        isDeferred: false,
        description: 'Coordinator only: sends a message to the unit session of an issue through its mailbox; the unit\'s own session reads it at its next prompt '
          + 'or turn end, and an idle unit starts a turn for it. kind: inform (the default) for information, assign for new work, cancel to stop the unit\'s open work, '
          + 'the text its reason: its tools but send are denied until it replies done, and a cancel is refused when it owes no assign or still owes one. A text starting with / is refused, '
          + 'since a message runs no command: ask for a skill in plain text; a user\'s /flow approve, skip or follow-up goes through approve_unit, skip_unit or follow_up_unit. '
          + 'expects: step:<id>, a step of the unit\'s flow, on an assign or inform only; a message delivered while the unit is at another step is never shown to it: '
          + 'a stale assign is dead-lettered to the user and you are told, a stale inform is dropped.',
        inputSchema: { type: 'object', properties: { number: issueNumber, text: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['inform', 'assign', 'cancel'] },
          expects: { type: 'string', pattern: '^step:[\\w-]+$', description: 'The unit step the message is written for, such as step:code; refused on a cancel.' } },
          required: ['number', 'text'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'send',
        isDeferred: false,
        description: 'Sends a typed message through the mailboxes; never type into another session\'s terminal. A delegated unit opens a conversation with its coordinator: '
          + 'question (a design gap or a ⛳, with its options and your proposal) or blocked (stopped on something only the coordinator or the user can lift). '
          + 'A reply names the id of the message it answers in in_reply_to and goes back to that message\'s sender: answer to a question or a blocked, done to an assign or a cancel. '
          + 'Any other reply is refused, and a message is replied to once. Keep the body short; put long text in an issue comment and its URL in refs. '
          + 'A question lists its choices in options. A unit never addresses the user: a coordinator sends a unit\'s question only the user can answer on with '
          + 'to user and forward (its id; the body is your note), after which only the user answers it and you are told; or its own question with to user, issue and options. '
          + 'A question to the user needs at least two options, never expires, and its answer is information, never approval.',
        inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: [...sendKinds] }, body: { type: 'string', minLength: 1 },
          in_reply_to: { type: 'string', minLength: 1, description: 'The id of the message this answers; only for answer and done.' },
          refs: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'URLs or repository paths the body points to.' },
          options: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'A question\'s choices, labelled a, b, c… for the user.' },
          to: { type: 'string', enum: ['user'], description: 'Coordinator only: a question to the user\'s mailbox; left out, a unit\'s message goes to its coordinator.' },
          forward: { type: 'string', minLength: 1, description: 'With to user: the id of a unit\'s question to forward unchanged; the body is your note.' },
          issue: issueNumber },
        required: ['kind', 'body'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'unit_read',
        isDeferred: false,
        description: "Coordinator only: reads the recent terminal output of an issue's unit session.",
        inputSchema: { type: 'object', properties: { number: issueNumber, lines: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['number'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'approve_unit',
        isDeferred: false,
        description: 'Coordinator only, under delegation: the only way to approve a delegated unit\'s diagnosis; unit_prompt refuses a literal /flow approve. '
          + 'Takes a typed message: kind approve, the delegated decision comment that approves (posted with issue_comment from this session after the diagnosis), the unit\'s diagnosis comment URL '
          + 'and its recorded red command. Refused unless the unit\'s Diagnose waits for approval, the decision is unchanged and unused, its Choice names /flow approve literally, as that command text and never a paraphrase, '
          + 'and its Choice or Reason cites both the diagnosis URL and the red command; then it sends the unit a step message, which the unit\'s mod checks again before it approves '
          + 'and answers with a done naming the outcome.',
        inputSchema: { type: 'object', properties: { number: issueNumber, kind: { type: 'string', enum: ['approve'] },
          decision: { type: 'string', minLength: 1, description: 'The delegated decision comment\'s URL.' },
          diagnosis: { type: 'string', minLength: 1, description: 'The unit\'s diagnosis comment URL, cited in the decision\'s Choice or Reason.' },
          red: { type: 'string', minLength: 1, description: 'The unit\'s recorded red command, argv joined by spaces, cited in the decision\'s Choice or Reason.' } },
        required: ['number', 'kind', 'decision', 'diagnosis', 'red'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'skip_unit',
        isDeferred: false,
        description: 'Coordinator only, under delegation: skips a step of a delegated unit\'s flow for the user, the only way to; unit_prompt refuses a literal /flow skip. '
          + 'Takes the delegated decision comment that skips it, posted with issue_comment from this session on the unit\'s issue, whose Choice names /flow skip <step> literally, as that command text and never a paraphrase, '
          + 'and whose Choice or Reason cites the reason. Refused unless the decision is unchanged and unused; then it sends the unit a step message, which the unit\'s mod '
          + 'checks again before it skips and answers with a done naming the outcome.',
        inputSchema: { type: 'object', properties: { number: issueNumber,
          decision: { type: 'string', minLength: 1, description: 'The delegated decision comment\'s URL.' },
          step: { type: 'string', minLength: 1, description: 'The id of the step to skip, such as diagnose, named in the decision\'s Choice as /flow skip <step>.' },
          reason: { type: 'string', minLength: 1, description: 'Why it is skipped, cited in the decision\'s Choice or Reason.' } },
        required: ['number', 'decision', 'step', 'reason'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'follow_up_unit',
        isDeferred: false,
        description: 'Coordinator only, under delegation: declares Follow-up on an issue in a delegated unit for the user, the only way to; unit_prompt refuses a literal /flow follow-up. '
          + 'Takes the delegated decision comment that declares it, posted with issue_comment from this session on the unit\'s issue, whose Choice names /flow follow-up #<issue> literally, as that command text and never a paraphrase. '
          + 'Refused unless the decision is unchanged and unused; then it sends the unit a step message, which the unit\'s mod checks again before it declares and answers '
          + 'with a done naming the outcome.',
        inputSchema: { type: 'object', properties: { number: issueNumber,
          decision: { type: 'string', minLength: 1, description: 'The delegated decision comment\'s URL.' },
          issue: { ...issueNumber, description: 'The issue whose open PR the follow-up adds to, named in the decision\'s Choice as /flow follow-up #<issue>.' } },
        required: ['number', 'decision', 'issue'], additionalProperties: false },
      })
      await $.tool.register({
        name: 'retire_unit',
        isDeferred: false,
        description: 'Coordinator only, under delegation: retires the unit of an issue in its scope so a later spawn starts it fresh. The mod archives the branch tip '
          + 'as refs/retired/<n>/<timestamp> and uncommitted changes as a patch, posts the retirement as a delegated decision on the issue, then removes the herdr workspace, '
          + 'worktree, branch, records and transcript, and names the restore command. Refused for a branch with a PR or merged into another branch, the calling session\'s own unit, '
          + 'and issues outside the scope, whose retirement is the user\'s /flow retire.',
        inputSchema: { type: 'object', properties: { number: issueNumber, reason: { type: 'string', minLength: 1, description: 'Why the unit is redone: the decision\'s reason.' } },
          required: ['number', 'reason'], additionalProperties: false },
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
  setContinueAtUsageLimit(options.continueAtUsageLimit)

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

  // why: no engine call reads the permission mode, so spawn takes the one the session last reported, at most one tool call old.
  // why: the classic event, unlike prompt.submit, is known to fire for the mod's own doorbell prompt, so the mail rides on it.
  on('classic.UserPromptSubmit', ($, e, next) => { sessionMemory.permissionMode = e.permission_mode ?? null; return handleMailPromptSubmit(createEnginePort($, 'mail'), e, next) })
  on('classic.PostToolUse', (_$, e, next) => { sessionMemory.permissionMode = e.permission_mode ?? null; return next(e) })

  // The read-only side fails open: a failed read submits the prompt with the notice instead of the flow line; a chain already called is passed through.
  on('prompt.submit', ($, e, next) => handlePromptSubmit(createEnginePort($, 'prompt'), e, next))
    .catch((_$, e, next) => next.called ? next(e) : next({ ...e, context: [...(e.context ?? []), describeUnreadState(describeHookError(next.error))] }))

  on('skill.prompt', ($, e, next) => handleSkillPrompt(createEnginePort($, `skill ${e.skill}`), e, next))

  on('turn.start', ($, e, next) => handleTurnStart(createEnginePort($, 'turn start'), e, next))
  on('turn.complete', ($, e, next) => handleTurnComplete(createEnginePort($, 'turn end'), e, next))
  // A permission dialog holds a delegated unit mid-turn, so its coordinator hears of it here rather than at the turn end.
  on('classic.Notification', ($, e, next) => handleNotification(createEnginePort($, 'notification'), e, next))

  // A coordinator never declares a flow; this hook answers without next, so the guard runs inside it.
  on('tool.call', { tool: declareTool }, async ($, e) => {
    const port = createEnginePort($, 'declare_flow')
    const deny = await denyCoordinatorCall(port, e)
    return deny ? { deny } : handleDeclareFlowCall(port, e)
  }).catch((_$, _e, next) => ({ deny: `${checkFailed} ${describeHookError(next.error)}` }))

  // Registration order nests hooks: the window must precede Verify and Run, which answer without next.
  // Its .catch also answers a call re-entered beneath the hook's own $ calls (next.called false): the check never ran on it, so it is denied.
  // A timed-out check is retried once inside the grace before it denies (core/check-retry); a failure that is not a timeout denies at once.
  on('tool.call', ($, e, next) => measureGuard<typeof e, Awaited<ReturnType<typeof next>>>('tool.call', proceed => handleToolCall(createEnginePort($, `tool ${e.tool}`), e, proceed),
    usage => { reportGuardUsage(createEnginePort($, 'guard usage'), usage) })(e, next))
    .catch(($, e, next) => guardCatch<typeof e, Awaited<ReturnType<typeof next>>>({ guard: 'tool.call', check: proceed => handleToolCall(createEnginePort($, `tool ${e.tool}`), e, proceed),
      deny: reason => ({ deny: reason }), sleep: (delayMs, signal) => $.clock.sleep(delayMs, { signal }),
      onTimeout: timeout => { reportGuardTimeout(createEnginePort($, 'guard timeout'), timeout) } })(e, next))

  on('tool.call', { tool: `${modToolPrefix}verify` }, ($, _e, next) => handleVerify(createEnginePort($, 'verify'), next.signal))
    .catch((_$, _e, next) => failedToolAnswer('Verify could not run', next.error))

  on('tool.call', { tool: `${modToolPrefix}run` }, ($, e, next) => handleRun(createEnginePort($, 'run'), { argv: e.argv }, next.signal))
    .catch((_$, _e, next) => failedToolAnswer('Run could not run', next.error))

  on('tool.call', { tool: suggestCoordinateTool }, $ => handleSuggestCall(createEnginePort($, 'suggest coordinate')))
    .catch((_$, _e, next) => failedToolAnswer('The suggestion was not shown', next.error))

  on('tool.call', { tool: suggestDelegateTool }, ($, e) => handleSuggestDelegateCall(createEnginePort($, 'suggest delegate'), e))
    .catch((_$, _e, next) => failedToolAnswer('The suggestion was not shown', next.error))

  on('tool.call', { tool: `${modToolPrefix}merge_child` }, ($, e, next) => handleMergeChildCall(createEnginePort($, 'merge child'), e, next.signal))
    .catch((_$, _e, next) => failedToolAnswer('merge_child could not run, so check the parent branch before anything else', next.error))

  on('tool.call', { tool: `${modToolPrefix}commit` }, async ($, e) => {
    const message: unknown = ({ ...e } as Record<string, unknown>).message
    if (typeof message !== 'string' || !message.trim()) return { result: markForAgent('message must be the commit message.'), isError: true }
    const done = await commitDelegated(createEnginePort($, 'commit'), message)
    return answerTool('commit', done)
  })
  on('tool.call', { tool: `${modToolPrefix}merge_parent` }, async $ => {
    const done = await mergeParent(createEnginePort($, 'merge parent'))
    return answerTool('merge_parent', done)
  })
  on('tool.call', { tool: `${modToolPrefix}send` }, async ($, e) => answerTool('send', await sendTyped(createEnginePort($, 'send'), { ...e } as Record<string, unknown>)))
    .catch((_$, _e, next) => failedToolAnswer('send failed, so the message may not have been sent', next.error))
  on('tool.call', { tool: `${modToolPrefix}plan` }, $ => handlePlanCall(createEnginePort($, 'plan')))
    .catch((_$, _e, next) => failedToolAnswer('plan could not run', next.error))

  for (const tool of issueTools) {
    on('tool.call', { tool: `${modToolPrefix}${tool}` }, ($, e) => handleIssueCall(createEnginePort($, tool), tool, e))
      .catch((_$, _e, next) => failedToolAnswer(`${tool} could not run, so nothing is confirmed written`, next.error))
  }

  for (const tool of unitTools) {
    on('tool.call', { tool: `${modToolPrefix}${tool}` }, ($, e) => handleUnitCall(createEnginePort($, tool), tool, e))
      .catch((_$, _e, next) => failedToolAnswer(`${tool} failed`, next.error))
  }

  // A coordinator's role must hold in every loop; a check that cannot read the role denies.
  on('tool.check', ($, e, next) => measureGuard<typeof e, Awaited<ReturnType<typeof next>>>('tool.check', proceed => handleToolCheck(createEnginePort($, `check ${e.tool}`), e, proceed),
    usage => { reportGuardUsage(createEnginePort($, 'guard usage'), usage) })(e, next))
    .catch(($, e, next) => guardCatch<typeof e, Awaited<ReturnType<typeof next>>>({ guard: 'tool.check', check: proceed => handleToolCheck(createEnginePort($, `check ${e.tool}`), e, proceed),
      deny: reason => ({ decision: 'deny' as const, reason }), sleep: (delayMs, signal) => $.clock.sleep(delayMs, { signal }),
      onTimeout: timeout => { reportGuardTimeout(createEnginePort($, 'guard timeout'), timeout) } })(e, next))

  on('agent.spawn', ($, e, next) => measureGuard<typeof e, Awaited<ReturnType<typeof next>>>('agent.spawn', proceed => handleAgentSpawn(createEnginePort($, 'agent spawn'), e, proceed),
    usage => { reportGuardUsage(createEnginePort($, 'guard usage'), usage) })(e, next))
    .catch(($, e, next) => guardCatch<typeof e, Awaited<ReturnType<typeof next>>>({ guard: 'agent.spawn', check: proceed => handleAgentSpawn(createEnginePort($, 'agent spawn'), e, proceed),
      deny: reason => ({ deny: reason }), sleep: (delayMs, signal) => $.clock.sleep(delayMs, { signal }),
      onTimeout: timeout => { reportGuardTimeout(createEnginePort($, 'guard timeout'), timeout) } })(e, next))

  on('command.run', { command: 'flow' }, async ($, e) => ({ text: await handleFlowCommand(createEnginePort($, `/flow ${e.args.trim().split(/\s+/)[0] ?? ''}`.trim()), e) }))

  on('ui.render', { component: 'Pane', requestId: paneId }, ($, e, next) => handlePaneRender(createEnginePort($, 'pane'), $.ui.resolve(e), e.props, next.signal))
  on('ui.close', { id: paneId }, ($, e, next) => handlePaneClose(createEnginePort($, 'pane close'), e, next))
}
