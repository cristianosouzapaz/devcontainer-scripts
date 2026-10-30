import { isIssueNumber, isNonEmptyString, isRecord, isStringArray, rejectUnknownFields } from '../lib/guards'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'

/** A label `/flow setup-labels` creates or updates, with its optional color and description. */
interface LabelSpec { color?: string; description?: string }

/** The validated `issues` section of `.claude/working-agreement.json`, defaults applied. */
export interface IssuesConfig {
  title: RegExp; sections: Record<string, string[]>; types: string[]; priorities: string[]
  labels: Record<string, LabelSpec>; milestone?: string; project?: string; nativeTypes: Record<string, string>
}

/** The fields an issue write sets, as the tool call carries them; every one is optional until a tool requires it. */
export interface IssueInput {
  number?: number; title?: string; kind?: string; sections?: Record<string, string>; type?: string; priority?: string
  triage?: string; labels?: string[]; assignees?: string[]; milestone?: string; project?: string; parent?: number; blockedBy?: number[]
  state?: string; reason?: string; duplicateOf?: number; comment?: string; body?: string
}

/** A label family an issue carries exactly one of. */
interface LabelFamily { family: 'triage' | 'type' | 'priority'; allowed: string[] }

/** The labels an issue write applies and the body it writes, once the fields passed. */
interface CheckedFields { labels: string[]; body?: string }

/** The triage labels; every issue carries exactly one. */
export const triageLabels = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix']

/** The label an issue carries while one of its delegated decisions is unreviewed. */
export const reviewLabel = 'delegated-review'

const defaultLabels: Record<string, LabelSpec> = {
  'needs-triage': { color: 'd4c5f9', description: 'Needs evaluation before work can start' },
  'needs-info': { color: 'fbca04', description: 'Waiting for more information from the reporter' },
  'ready-for-agent': { color: '0e8a16', description: 'Spec is complete and ready to be implemented' },
  'ready-for-human': { color: '0e8a16', description: 'Ready, but needs a human decision or interview first' },
  wontfix: { color: 'ffffff', description: 'Will not be worked on' },
  [reviewLabel]: { color: 'c5def5', description: 'Has delegated decisions the user has not reviewed yet' },
  'type::build': { color: '6c757d', description: 'Build system or dependencies' },
  'type::chore': { color: 'adb5bd', description: 'Maintenance, no src/test change' },
  'type::ci': { color: '495057', description: 'CI configuration' },
  'type::config': { color: '795548', description: 'Configuration changes' },
  'type::docs': { color: '1f75cb', description: 'Documentation only' },
  'type::feat': { color: '2da160', description: 'New feature' },
  'type::fix': { color: 'd9534f', description: 'Bug fix' },
  'type::perf': { color: 'f0ab00', description: 'Performance improvement' },
  'type::refactor': { color: '8e44ad', description: 'Code change that neither fixes a bug nor adds a feature' },
  'type::revert': { color: '212529', description: 'Reverts a previous commit' },
  'type::style': { color: 'e91e8c', description: 'Formatting, no logic change' },
  'priority::high': { color: 'c0392b', description: 'Blocks or should merge soon' },
  'priority::medium': { color: 'e67e22', description: 'Normal priority' },
  'priority::low': { color: '7f8c8d', description: 'Nice to have, no rush' },
}
// why: absent lists default to the Conventional Commit types and three priorities, so an unconfigured repository is as strict as a configured one; [] opts out.
const defaultTypes = ['build', 'chore', 'ci', 'config', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style']
const defaultPriorities = ['high', 'medium', 'low']

const defaultSections: Record<string, string[]> = {
  spec: ['Problem', 'Solution', 'Acceptance criteria'],
  ticket: ['Parent', 'What to build', 'Acceptance criteria', 'Blocked by'],
  bug: ['Observed', 'Expected', 'Evidence', 'Impact'],
  decision: [],
}

const defaultTitle = '^[a-z]+(\\([^()\\s]+\\))?!?: \\S.*$'
/** The state reasons an issue may close with. */
export const closeReasons = ['completed', 'not planned', 'duplicate']
/** Where a refusal over a missing label sends the agent. */
export const setupHint = 'the user runs /flow setup-labels to create the configured labels'

/**
 * Reads an optional list of non-empty names.
 * @param value - The untrusted value.
 * @param path - Its JSON path.
 * @returns The names, empty when absent.
 */
function names(value: unknown, path: string): string[] {
  if (value === undefined) return []
  if (!isStringArray(value) || value.some(item => !item)) throw new Error(`${path}: expected an array of non-empty strings`)
  return value
}

/**
 * Reads an optional object whose every value passes a check.
 * @param value - The untrusted value.
 * @param path - Its JSON path.
 * @param check - Validates one entry's value.
 * @returns The object, empty when absent.
 */
function entries<T>(value: unknown, path: string, check: (item: unknown, path: string) => T): Record<string, T> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${path}: expected an object`)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, check(item, `${path}.${key}`)]))
}

/**
 * Reads an optional non-empty string.
 * @param value - The untrusted value.
 * @param path - Its JSON path.
 * @returns The string, or undefined when absent.
 */
function optionalText(value: unknown, path: string): string | undefined {
  if (value !== undefined && !isNonEmptyString(value)) throw new Error(`${path}: expected a non-empty string`)
  return value
}

/**
 * Compiles the title pattern.
 * @param source - The pattern's source.
 * @returns The pattern; an invalid one throws with its JSON path.
 */
function compileTitle(source: string): RegExp {
  try { return new RegExp(source) } catch { throw new Error('issues.title: invalid regular expression') }
}

/**
 * Validates the `issues` section and supplies the defaults for what it leaves out.
 * @param section - The section, or undefined when the config has none.
 * @returns The config; a malformed section throws with its JSON path.
 */
export function parseIssuesConfig(section: unknown): IssuesConfig {
  const value = section === undefined ? {} : section
  if (!isRecord(value)) throw new Error('issues: expected an object')
  rejectUnknownFields(value, ['title', 'sections', 'types', 'priorities', 'labels', 'milestone', 'project', 'nativeTypes'], 'issues')
  const title = compileTitle(optionalText(value.title, 'issues.title') ?? defaultTitle)
  const labels = entries(value.labels, 'issues.labels', (item, path) => {
    if (!isRecord(item)) throw new Error(`${path}: expected an object`)
    rejectUnknownFields(item, ['color', 'description'], path)
    if (item.color !== undefined && (typeof item.color !== 'string' || !/^[0-9a-fA-F]{6}$/.test(item.color))) throw new Error(`${path}.color: expected six hexadecimal digits`)
    return { ...(item.color === undefined ? {} : { color: item.color }), ...(item.description === undefined ? {} : { description: optionalText(item.description, `${path}.description`) }) }
  })
  const types = value.types === undefined ? defaultTypes : names(value.types, 'issues.types')
  const priorities = value.priorities === undefined ? defaultPriorities : names(value.priorities, 'issues.priorities')
  // types and priorities are the values an issue may take; a label key only styles one, so a key naming no value is a typo.
  const declared = new Set(listLabelFamilies({ types, priorities }).flatMap(({ allowed }) => allowed))
  const isUndeclared = (name: string): boolean => /^(type|priority)::/.test(name) && !declared.has(name)
  const stray = Object.keys(labels).find(isUndeclared)
  if (stray !== undefined) throw new Error(`issues.labels.${stray}: not declared in issues.types or issues.priorities`)
  return {
    title,
    sections: { ...defaultSections, ...entries(value.sections, 'issues.sections', names) },
    types,
    priorities,
    labels: Object.fromEntries(Object.entries({ ...defaultLabels, ...labels }).filter(([name]) => !isUndeclared(name))),
    ...(value.milestone === undefined ? {} : { milestone: optionalText(value.milestone, 'issues.milestone') }),
    ...(value.project === undefined ? {} : { project: optionalText(value.project, 'issues.project') }),
    nativeTypes: entries(value.nativeTypes, 'issues.nativeTypes', (item, path) => optionalText(item, path) ?? ''),
  }
}

/**
 * Lists the label families every issue carries exactly one of: triage, then type and priority when any is configured.
 * @param config - The configured types and priorities.
 * @returns Each family with its labels.
 */
export function listLabelFamilies(config: Pick<IssuesConfig, 'types' | 'priorities'>): LabelFamily[] {
  return [
    { family: 'triage', allowed: triageLabels },
    ...(config.types.length ? [{ family: 'type' as const, allowed: config.types.map(type => `type::${type}`) }] : []),
    ...(config.priorities.length ? [{ family: 'priority' as const, allowed: config.priorities.map(priority => `priority::${priority}`) }] : []),
  ]
}

/**
 * Tells a wayfinder decision issue, which is exempt from the title pattern and the body sections.
 * @param labels - The issue's labels.
 * @returns Whether a `wayfinder:*` label is among them.
 */
export const isDecisionIssue = (labels: string[]): boolean => labels.some(label => label.startsWith('wayfinder:'))

/**
 * Lists every label `/flow setup-labels` creates or updates: the styled ones, then each family label left unstyled.
 * @param config - The issues config.
 * @returns The labels by name, in a stable order.
 */
export function listSetupLabels(config: IssuesConfig): [string, LabelSpec][] {
  const unstyled = listLabelFamilies(config).flatMap(({ allowed }) => allowed).filter(name => !(name in config.labels))
  return [...Object.entries(config.labels), ...unstyled.map((name): [string, LabelSpec] => [name, {}])]
}

/**
 * Reads the tool call's fields, refusing a value of the wrong shape.
 * @param args - The call's arguments.
 * @returns The fields, or the first malformed one.
 */
export function readIssueInput(args: Record<string, unknown>): Result<IssueInput> {
  const input: Record<string, unknown> = {}
  for (const key of ['title', 'kind', 'type', 'priority', 'triage', 'milestone', 'project', 'state', 'reason', 'comment', 'body']) {
    if (args[key] === undefined) continue
    if (!isNonEmptyString(args[key])) return fail(`${key} must be a non-empty string.`)
    input[key] = args[key]
  }
  for (const key of ['number', 'parent', 'duplicateOf']) {
    if (args[key] === undefined) continue
    if (!isIssueNumber(args[key])) return fail(`${key} must be an issue number.`)
    input[key] = args[key]
  }
  for (const key of ['labels', 'assignees']) {
    if (args[key] === undefined) continue
    if (!isStringArray(args[key]) || args[key].some(item => !item)) return fail(`${key} must be a list of non-empty strings.`)
    input[key] = args[key]
  }
  if (args.blockedBy !== undefined) {
    if (!Array.isArray(args.blockedBy) || !args.blockedBy.every(isIssueNumber)) return fail('blockedBy must be a list of issue numbers.')
    input.blockedBy = args.blockedBy
  }
  if (args.sections !== undefined) {
    if (!isRecord(args.sections) || !Object.values(args.sections).every(isNonEmptyString)) return fail('sections must map each heading to non-empty markdown.')
    input.sections = args.sections
  }
  if (input.reason !== undefined && !closeReasons.includes(String(input.reason))) return fail(`reason must be one of: ${closeReasons.join(', ')}.`)
  if (input.state !== undefined && input.state !== 'open') return fail('state can only be "open" (reopen); issue_close closes.')
  return succeed(input as IssueInput)
}

/**
 * Writes the body from its sections after checking the kind's configured headings are all there.
 * @param config - The issues config.
 * @param kind - The issue's kind.
 * @param sections - Each heading's markdown, in body order.
 * @returns The body, or the refusal naming the kind's sections.
 */
function composeBody(config: IssuesConfig, kind: string | undefined, sections: Record<string, string>): Result<string> {
  const required = kind === undefined ? undefined : config.sections[kind]
  if (!required) return fail(`kind must be one of: ${Object.keys(config.sections).join(', ')}.`)
  const missing = required.filter(heading => !sections[heading]?.trim())
  if (missing.length) return fail(`A ${kind} body needs the sections ${required.join(' / ')}; missing: ${missing.join(', ')}.`)
  return succeed(Object.entries(sections).map(([heading, text]) => `## ${heading}\n\n${text.trim()}`).join('\n\n'))
}

/**
 * Picks the one label of a family the issue ends with: the requested one, or the one it keeps.
 * @param family - What the label is, for the refusal.
 * @param allowed - The family's labels.
 * @param requested - The label the call sets, if any.
 * @param current - The labels the issue has now.
 * @returns The labels it ends with from this family.
 */
function pickOne(family: string, allowed: string[], requested: string | undefined, current: string[]): Result<string[]> {
  if (requested !== undefined && !allowed.includes(requested)) return fail(`${family} must be one of: ${allowed.join(', ')}.`)
  const kept = requested === undefined ? current.filter(label => allowed.includes(label)) : [requested]
  return kept.length === 1 ? succeed(kept) : fail(`Exactly one ${family} label is required (one of: ${allowed.join(', ')}).`)
}

/**
 * Checks an issue's fields against the config and the repository's live labels, and lists the labels it ends with.
 * @param config - The issues config.
 * @param input - The call's fields.
 * @param repoLabels - The repository's label names.
 * @param current - The issue's labels now, empty for a new issue.
 * @returns The final labels and the body to write, or the refusal.
 */
export function checkIssueFields(config: IssuesConfig, input: IssueInput, repoLabels: ReadonlySet<string>, current: string[] = []): Result<CheckedFields> {
  const extra = input.labels ?? []
  if (input.title !== undefined && !isDecisionIssue([...extra, ...current]) && !config.title.test(input.title)) return fail(`The title must match ${config.title.source} (e.g. "feat(scope): summary").`)
  const requested = { triage: input.triage, type: input.type && `type::${input.type}`, priority: input.priority && `priority::${input.priority}` }
  const families = listLabelFamilies(config)
  if (input.type !== undefined && !config.types.length) return fail('No issue types are configured (issues.types), so type cannot be set.')
  if (input.priority !== undefined && !config.priorities.length) return fail('No priorities are configured (issues.priorities), so priority cannot be set.')
  const owned = families.flatMap(({ allowed }) => allowed)
  const stray = extra.find(label => owned.includes(label))
  if (stray) return fail(`${stray} is set through triage, type or priority, not labels.`)
  const labels: string[] = []
  for (const { family, allowed } of families) {
    const absent = allowed.filter(label => !repoLabels.has(label))
    if (family !== 'triage' && absent.length) return fail(`The repository lacks the configured ${family} labels ${absent.join(', ')} — ${setupHint}.`)
    const picked = pickOne(family, allowed, requested[family], current)
    if (!picked.isOk) return picked
    labels.push(...picked.value)
  }
  const missing = [...labels, ...extra].filter(label => !repoLabels.has(label))
  if (missing.length) return fail(`The repository lacks the labels ${missing.join(', ')} — ${setupHint}.`)
  const kept = current.filter(label => !owned.includes(label))
  const final = [...new Set([...kept, ...labels, ...extra])]
  if (input.sections === undefined) return input.kind === undefined ? succeed({ labels: final }) : fail('kind is given without sections.')
  const body = composeBody(config, input.kind, input.sections)
  return body.isOk ? succeed({ labels: final, body: body.value }) : body
}
