import type { HookFailure } from 'claude-code'

import type { Result } from '../lib/result'

/** A mod tool's answer to the agent. */
interface ToolAnswer { result: string; isError?: true }

/** The prefix the engine gives every tool this mod registers. */
export const modToolPrefix = 'mcp__working-agreement__'

/**
 * Marks a text as the working agreement's, for text the agent reads (prompt context, denies, tool results).
 *
 * @param text - The sentence the agent reads.
 * @returns The text, prefixed with `[working-agreement]`.
 */
export const markForAgent = (text: string): string => `[working-agreement] ${text}`

/**
 * Appends the user's free text to a prompt the mod writes, verbatim, under its own heading.
 *
 * @param prompt - The mod's fixed prompt.
 * @param instructions - The user's free text; empty appends nothing.
 * @returns The prompt, followed by `User's instructions:` and the text when there is any.
 */
export const appendInstructions = (prompt: string, instructions: string): string => instructions ? `${prompt}\n\nUser's instructions:\n${instructions}` : prompt

/**
 * Formats issue numbers as references.
 *
 * @param issues - The issue numbers.
 * @param separator - What goes between two references.
 * @returns The `#n` references, joined.
 */
export const formatIssueReferences = (issues: number[], separator: string): string => issues.map(number => `#${number}`).join(separator)

/**
 * Counts a noun in English.
 *
 * @param count - The count.
 * @param word - The singular noun.
 * @returns The count and the noun, plural unless the count is one.
 */
export const pluralize = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * Answers a mod tool's call with its outcome, a refusal naming the tool.
 *
 * @param tool - The tool's name, without the mod's prefix.
 * @param outcome - What the tool did, or why it refused.
 * @returns The result the agent reads, an error on a refusal.
 */
export const answerTool = (tool: string, outcome: Result<string>): ToolAnswer =>
  outcome.isOk ? { result: markForAgent(outcome.value) } : { result: markForAgent(`${tool} refused: ${outcome.error}`), isError: true }

/**
 * Names why a hook failed, for the answer its .catch gives.
 *
 * @param error - The hook's failure.
 * @returns What was thrown, or the failure's kind when nothing was.
 */
export const describeHookError = (error: HookFailure): string => error.message ?? error.kind

/**
 * Answers the agent when a mod tool's hook failed, naming what could not happen and why; each hook's .catch calls it, since the engine
 * accepts only a function literal there.
 *
 * @param label - What could not happen, as the agent reads it before the failure.
 * @param error - The hook's failure.
 * @returns The error result the agent reads.
 */
export const failedToolAnswer = (label: string, error: HookFailure): ToolAnswer =>
  ({ result: markForAgent(`${label}: ${describeHookError(error)}`), isError: true })
