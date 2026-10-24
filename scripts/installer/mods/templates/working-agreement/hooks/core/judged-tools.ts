/** The tools that write files by path. */
const fileTools = ['Edit', 'Write', 'NotebookEdit']

/**
 * Tells whether the write checks judge a tool call.
 *
 * @param tool - The tool's name.
 * @returns True for the file-writing tools.
 */
export const isJudgedTool = (tool: string): boolean => fileTools.includes(tool)
