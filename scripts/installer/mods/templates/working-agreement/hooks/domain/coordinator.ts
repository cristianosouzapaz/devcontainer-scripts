import { suggestDelegateTool } from './delegation'
import { appendInstructions, markForAgent, modToolPrefix } from './messages'

/** The mod tool that proposes `/flow coordinate` in the prompt box. */
export const suggestCoordinateTool = `${modToolPrefix}suggest_coordinate`
/** The issue tools, by the name after the mod's prefix. */
export const issueTools = ['issue_create', 'issue_edit', 'issue_close', 'issue_comment'] as const
/** The coordinator's tools that start, message, escalate and retire unit sessions, by the name after the mod's prefix. */
export const unitTools = ['spawn', 'unit_prompt', 'unit_read', 'retire_unit', 'escalate_unit'] as const

// why: These tools write nothing in the repository but the engine does not mark them read-only; Agent is safe here
// because every call of the subagent it starts is checked again under its agentId. The issue tools are the coordinator's
// only GitHub write channel, spawn starts the unit sessions that do write, unit_prompt is its only channel to them, retire_unit
// removes a delegated unit only after the mod archived its work and posted the decision, escalate_unit only resumes a unit's own session on a higher level, and
// merge_child is its one repository write, which the mod itself runs only for a delegated child/parent pair it knows; plan only reads.
const modTools = [suggestCoordinateTool, suggestDelegateTool, ...[...issueTools, ...unitTools, 'merge_child', 'plan'].map(name => `${modToolPrefix}${name}`)]
const allowedTools = ['Agent', 'Skill', 'ToolSearch', 'AskUserQuestion', 'TodoWrite', ...modTools]

// why: Reads the engine cannot recognize as read-only; each is matched as an exact argv prefix, so a write subcommand never matches.
const allowedCommands = [
  'gh issue view', 'gh issue list', 'gh pr view', 'gh pr list', 'gh pr checks', 'gh pr diff', 'gh repo view', 'gh run view', 'gh run list',
  'herdr agent list', 'herdr agent get', 'herdr agent read',
].map(command => command.split(' '))

// why: Any of these lets a simple-looking command chain, redirect or substitute another one.
const shellMetacharacters = /[;|&><$`\n]/

/** Where a denied coordinator call is told the writing happens instead. */
export const coordinatorDeny = markForAgent('This session is the coordinator, which never writes in the repository — ' +
  'reads, analysis and read-only subagents are allowed; any write belongs to a unit session in its own herdr worktree (spawn one), never to the coordinator or its subagents.')
// why: The allowlist cannot tell a chain of reads from a chain hiding a write, so it is refused without being called a write.
const compoundDeny = markForAgent('This command was not recognized as read-only: the coordinator\'s read allowlist accepts only a simple command, ' +
  'without ; | & > < $ backticks or newlines. If every part is a read, run each part on its own; a write belongs to a unit session in its own herdr worktree (spawn one).')

/**
 * Writes the prompt `/flow coordinate` submits; the same text always writes the same bytes.
 * @param instructions - The user's free text, appended verbatim; empty appends nothing.
 * @returns The prompt, which asks the user before anything starts.
 */
export function composeCoordinatePrompt(instructions: string): string {
  return appendInstructions('Show the open ready-for-agent issues, the running unit sessions (herdr agent list) and the delegated decisions awaiting review ' +
    '(open issues labelled delegated-review), then ask the user what to coordinate. Start nothing: spawn no unit and prompt none until the user answers.', instructions)
}

/**
 * Refuses a coordinator or a delegation while hooks modules run ahead of the mod: the engine takes the outermost hook's
 * verdict in either direction, over the mod's deny and over settings deny rules alike, so the guards would not hold.
 * @param ahead - The hooks modules the engine nests outside the mod, outermost first.
 * @returns The refusal, or undefined when the mod is the outermost module.
 */
export function refuseModulesAhead(ahead: readonly string[] | null): string | undefined {
  if (ahead === null) return 'Refused: a plugin refresh left the hooks module order unknown, so a module ahead could override the mod\'s guards. Restart the session.'
  return ahead.length ? `Refused: ${ahead.join(', ')} ${ahead.length === 1 ? 'is a hooks module' : 'are hooks modules'} ahead of the working-agreement mod, and a hook ahead overrides its guards. Disable or uninstall ${ahead.length === 1 ? 'it' : 'them'}, then start a new session.` : undefined
}

/**
 * Tells a coordinator session from any other.
 * @param session - The session record.
 * @param session.role - The session's role.
 * @returns Whether its role is the coordinator.
 */
export const isCoordinatorSession = (session: { role?: string }): boolean => session.role === 'coordinator'

/**
 * Reads the hooks modules nested outside the mod from the list an engine build names, outermost first. The list is the whole set at a
 * load and the mod alone at its own reload, which keeps the order known before; a refresh that omits the mod may add a module anywhere.
 * @param plugins - The modules the build names, in nesting order.
 * @param known - The modules ahead known before this build, or null when unknown.
 * @returns The modules ahead, or null when the order is unknown.
 */
export function readModulesAhead(plugins: readonly string[], known: readonly string[] | null): readonly string[] | null {
  const index = plugins.indexOf('working-agreement')
  if (index < 0) return null
  return plugins.length === 1 && known ? known : plugins.slice(0, index)
}

/**
 * Tells whether a Bash command is a simple command on the coordinator's read allowlist.
 * @param command - The command line as the model wrote it.
 * @returns True when it carries no shell metacharacter and starts with an allowed argv.
 */
function isAllowedCommand(command: string): boolean {
  if (shellMetacharacters.test(command)) return false
  const argv = command.trim().split(/\s+/)
  return allowedCommands.some(prefix => prefix.every((word, index) => argv[index] === word))
}

/**
 * Tells whether the coordinator may run a call the engine does not hold read-only.
 * @param tool - The called tool.
 * @param input - The call's arguments.
 * @returns True for an allowlisted tool or an allowlisted simple Bash command.
 */
export function isAllowedForCoordinator(tool: string, input: unknown): boolean {
  if (allowedTools.includes(tool)) return true
  const command = tool === 'Bash' ? readCommand(input) : undefined
  return command !== undefined && isAllowedCommand(command)
}

/**
 * Names why the coordinator's permission check refuses a call it does not allow.
 * @param tool - The called tool.
 * @param input - The call's arguments.
 * @returns The compound-command reason for a Bash command with a shell metacharacter, else the coordinator's deny.
 */
export function explainCoordinatorDeny(tool: string, input: unknown): string {
  const command = readCommand(input)
  return tool === 'Bash' && command !== undefined && shellMetacharacters.test(command) ? compoundDeny : coordinatorDeny
}

/**
 * Reads a Bash call's command from its untyped arguments.
 * @param input - The call's arguments.
 * @returns The command, or undefined when the arguments carry no string command.
 */
function readCommand(input: unknown): string | undefined {
  return typeof input === 'object' && input !== null && 'command' in input && typeof input.command === 'string' ? input.command : undefined
}

/**
 * Names what the coordinator's tool call guard refuses before any tool runs, the mod's own tools included.
 * @param tool - The called tool.
 * @param args - The call's arguments.
 * @returns The deny reason, or undefined when the permission check decides.
 */
export function judgeCoordinatorCall(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === 'Workflow') return coordinatorDeny
  if (tool === 'Agent' && (args.isolation === 'worktree' || args.isolation === 'remote')) return coordinatorDeny
  if (tool.startsWith('mcp__') && !modTools.includes(tool)) return coordinatorDeny
  return undefined
}
