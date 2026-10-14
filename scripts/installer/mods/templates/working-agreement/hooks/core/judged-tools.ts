import { sessionMemory } from './session-memory'

/** The tools that write files by path; Bash writes are found by parsing its command. */
export const fileTools = ['Edit', 'Write', 'NotebookEdit']

/**
 * Tells whether the permission mode puts an ask in front of the user; in any other mode an ask runs unanswered.
 *
 * @returns True in default and plan mode.
 */
export const canAskHuman = (): boolean => sessionMemory.permissionMode === 'default' || sessionMemory.permissionMode === 'plan'

/**
 * Tells whether the write and command checks judge a tool call.
 *
 * @param tool - The tool's name.
 * @param input - The tool's input.
 * @returns True for the file-writing tools, Bash, and a Monitor that runs a command.
 */
export const isJudgedTool = (tool: string, input: Record<string, unknown>): boolean =>
  fileTools.includes(tool) || tool === 'Bash' || (tool === 'Monitor' && typeof input.command === 'string')

/**
 * Names the tool a call is judged as: a Monitor's command runs in a shell as a Bash call's does, so it gets the same verdict.
 *
 * @param tool - The tool's name.
 * @returns Bash for a Monitor, the tool's own name otherwise.
 */
export const readJudgedTool = (tool: string): string => (tool === 'Monitor' ? 'Bash' : tool)
