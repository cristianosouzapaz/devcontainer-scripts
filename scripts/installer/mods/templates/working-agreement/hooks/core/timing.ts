/** The interval between background session refreshes. */
export const tickMs = 60000

/** How long a session start waits for the mod's tools to register before it shows them as not registered: far past a normal registration, well inside the mail stall. */
export const registrationBoundMs = 30000

/**
 * Bounds the age of cached GitHub reachability, issue metadata and mutable delivery facts.
 */
export const githubTtlMs = 60000

/**
 * Converts timeout minutes to milliseconds.
 */
export const minuteMs = 60000

/** How old a temporary file must be before a sweep removes it: it outlives one write or capture only when its session crashed. */
export const temporaryExpiryMs = 24 * 60 * minuteMs

/** How long after each attempt's transport ack a question, blocked or cancel must get its reply before its next attempt: five ticks of silence. */
export const replyDeadlineMs = 5 * minuteMs

/** How many ended turns the process state keeps, enough for any start still in flight behind them. */
export const endedTurnLimit = 16
