import type { Unit } from './records'

/** The headings a diagnosis comment must carry, in the order the comment presents them. */
export const diagnosisHeadings = ['Root cause', 'Evidence', 'Proposed fix', 'Regression test', 'Rejected hypotheses']

// The text under a Markdown heading, up to the next heading.
function readSection(body: string, heading: string): string | undefined {
  const lines = body.split('\n')
  const start = lines.findIndex(line => new RegExp(`^#{1,6}\\s*${heading}\\b`, 'i').test(line))
  if (start < 0) return undefined
  const length = lines.slice(start + 1).findIndex(line => /^#{1,6}\s/.test(line))
  return lines.slice(start + 1, length < 0 ? undefined : start + 1 + length).join('\n').trim()
}

/**
 * Lists what a diagnosis comment must carry but does not: each heading, the red's command quoted as run, the name of every red
 * file, and, when the red has no files in the repository, a Regression test section that explains why there is no test.
 *
 * @param unit - The unit, which holds the red; an overridden Red has none.
 * @param body - The comment text.
 * @returns The missing items as displayed, empty when the comment is complete.
 */
export function listMissingDiagnosis(unit: Unit, body: string): string[] {
  const files = Object.keys(unit.red?.fingerprints ?? {})
  return [
    ...diagnosisHeadings.filter(heading => readSection(body, heading) === undefined).map(heading => `the heading "${heading}"`),
    ...(unit.red && !body.includes(unit.red.command) ? [`the red command "${unit.red.command}"`] : []),
    ...files.filter(file => !body.includes(file)).map(file => `the red file ${file}`),
    ...(!files.length && readSection(body, 'Regression test') === '' ? ['a Regression test section that explains why there is no test'] : []),
  ]
}
