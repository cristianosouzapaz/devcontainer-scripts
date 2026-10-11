// A workflow's text without its comments: a `#` at the start of a line or after whitespace runs to the end of the line.
const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, '')

// Whether a name list or flow value mentions pull_request or pull_request_target as an event of its own, not as part of a longer name.
const isPullRequestNamed = (text: string): boolean => /(^|[^\w.-])pull_request(_target)?(?![\w.-])/.test(text)

// The width of a line's leading whitespace.
const measureIndent = (line: string): number => (/^\s*/.exec(line) ?? [''])[0].length

/**
 * Tells whether one GitHub Actions workflow triggers on pull requests through its `on:` key, written inline, as a flow
 * list or in block form, rather than through any mention of the word in a comment or a job.
 *
 * @param lines - The workflow's lines.
 * @returns True when `pull_request` or `pull_request_target` is among its triggers.
 */
export function hasPullRequestTrigger(lines: string[]): boolean {
  const code = lines.map(stripComment)
  // YAML 1.1 reads a bare `on` as true, so both spellings key the triggers.
  const start = code.findIndex(line => /^(on|"on"|'on'|true)\s*:/.test(line))
  if (start < 0) return false
  const inline = (code[start] ?? '').replace(/^[^:]*:/, '')
  const rest = code.slice(start + 1)
  // The block ends at the next line that is neither blank nor indented.
  const end = rest.findIndex(line => !!line.trim() && !/^\s/.test(line))
  const block = (end < 0 ? rest : rest.slice(0, end)).filter(line => line.trim())
  // An inline flow value may continue on indented lines: `on: [push,` then `  pull_request]`.
  if (inline.trim()) return isPullRequestNamed([inline, ...block].join('\n'))
  const indent = Math.min(...block.map(measureIndent))
  return block.some(line => {
    const trigger = /^\s*(?:-\s*)?["']?([\w-]+)/.exec(line)?.[1]
    return measureIndent(line) === indent && (trigger === 'pull_request' || trigger === 'pull_request_target')
  })
}
