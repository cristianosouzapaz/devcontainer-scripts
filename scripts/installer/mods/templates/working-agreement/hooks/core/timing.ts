/** The interval between background session refreshes. */
export const tickMs = 60000

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

/** How long after each attempt's send an assign must get its transport ack before its next attempt. */
export const ackDeadlineMs = 120000

/** How long after each attempt's transport ack a question, blocked or cancel must get its reply before its next attempt: five ticks of silence. */
export const replyDeadlineMs = 5 * minuteMs
