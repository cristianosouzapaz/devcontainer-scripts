/**
 * Pads a clock field to two digits.
 * @param value - The field, its sign dropped.
 * @returns The two-digit field.
 */
const pad = (value: number): string => String(Math.abs(value)).padStart(2, '0')

/**
 * Words a time in the user's local timezone.
 * @param at - The time in milliseconds.
 * @param isDated - Whether the date and the UTC offset lead and follow the time.
 * @returns `HH:MM`, or `YYYY-MM-DD HH:MM ±hh:mm` when dated.
 */
export function formatLocalTime(at: number, isDated: boolean): string {
  const date = new Date(at)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (!isDated) return clock
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock} ${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
}
