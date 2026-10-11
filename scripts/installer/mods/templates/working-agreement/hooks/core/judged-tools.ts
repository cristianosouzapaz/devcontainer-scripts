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
 * Tells whether the write and command checks judge a tool.
 *
 * @param tool - The tool's name.
 * @returns True for the file-writing tools and Bash.
 */
export const isJudgedTool = (tool: string): boolean => fileTools.includes(tool) || tool === 'Bash'
