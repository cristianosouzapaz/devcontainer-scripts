import type { FlowRow, FlowStepState, FlowTone, FlowView } from '../types'
import { declaredLabels, isCiWait, isPrStale, isUnitFinished, stepLabel, stepSymbol } from './progress'
import type { Position, StepState } from './progress'
import type { Gh, Session } from './records'

/** The width of a row's key column, in characters. */
export const keyWidth = 10

/** The Flow pane's colors. */
export const palette = {
  bg: '#23272e', text: '#d8dee9', muted: '#616e88', accent: '#88c0d0',
  done: '#a3be8c', warn: '#ebcb8b', error: '#bf616a', pill: '#3b4252',
}

/** The color of a row's value, by its tone. */
export const toneColor: Record<FlowTone, string> = { text: palette.text, muted: palette.muted, warn: palette.warn, error: palette.error }

/** The color of a step's symbol, by its state. */
export const symbolColor: Record<FlowStepState, string> = {
  done: palette.done, current: palette.accent, pending: palette.muted, skipped: palette.muted, override: palette.warn,
}

/** The color of a step's label, by its state. */
export const labelColor: Record<FlowStepState, string> = {
  done: palette.text, current: palette.accent, pending: palette.muted, skipped: palette.muted, override: palette.text,
}

/**
 * Counts a noun in English.
 *
 * @param n - The count.
 * @param word - The singular noun.
 * @returns The count and the noun, plural unless the count is one.
 */
export const pluralize = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Draws the horizontal rule across the pane's body, inside its padding.
 *
 * @param columns - The width of the pane's body, in characters.
 * @returns The rule.
 */
export const paneRule = (columns: number): string => '─'.repeat(Math.max(columns - 4, 1))

/**
 * Builds what the Flow pane shows for the session's unit.
 *
 * @param s - The session.
 * @param p - The unit's position.
 * @param gh - Whether GitHub is reachable.
 * @returns The pane's view.
 */
export function buildView(s: Session, p: Position, gh: Gh): FlowView {
  const isRunning = (st: StepState): boolean => !!p.running && st.state === 'current' && st.step.observe === 'verify.passed'
  const meta: FlowRow[] = []
  const notes: FlowRow[] = []
  if (p.g) {
    const bits = [p.g.branch, `${p.g.ahead} ahead of ${p.g.base}`]
    if (p.g.dirty) bits.push('uncommitted')
    meta.push({ key: 'Branch', value: bits.join(' · '), tone: 'text' })
    if (p.u.branch && p.u.branch !== p.g.branch) {
      notes.push({ key: 'Branch', value: `issue work is on ${p.u.branch} — writes here ask`, tone: 'warn' })
    }
  }
  if (s.followUp) meta.push({ key: 'Refs', value: `#${s.followUp}`, tone: 'text' })
  if (gh === 'unauth') meta.push({ key: 'GitHub', value: 'not authenticated — run gh auth login', tone: 'warn' })
  if (gh === 'unreachable') meta.push({ key: 'GitHub', value: 'unreachable — label and issue checks will ask', tone: 'warn' })
  for (const o of p.u.overrides) {
    const label = p.def.steps.find(st => st.id === o.step)?.label ?? o.step
    notes.push({ key: 'Override', value: `${label} — "${o.reason}" (by user)`, tone: 'warn' })
  }
  const { edits, shell } = s.blocked
  if (edits + shell) {
    const parts = [edits && pluralize(edits, 'edit'), shell && pluralize(shell, 'shell write')]
    notes.push({ key: 'Blocked', value: parts.filter(Boolean).join(', '), tone: 'error' })
  }
  if (s.handoff?.state === 'failed') {
    notes.push({ key: 'Handoff', value: `not completed — ${s.handoff.reason}. Nothing cleared.`, tone: 'error' })
  }
  const isFinished = isUnitFinished(s, p)
  const settled = p.states.filter(st => st.state !== 'current' && st.state !== 'pending').length
  return {
    flow: p.def.label,
    progress: `${settled}/${p.states.length}`,
    issues: s.issues.map(n => ({ number: n, title: s.info[n]?.title ?? '' })),
    pending: !s.issues.length && p.def.issue === 'produced' ? 'issue not yet created' : null,
    meta,
    labels: [...new Set(declaredLabels(s))],
    steps: p.states.map(st => ({
      symbol: stepSymbol[st.state],
      label: stepLabel(st.step, p.u.pr) + (isRunning(st) ? ' — running' : ''),
      state: st.state,
      hint: st.state === 'current' && st.step.human && st.step.skill ? `run /${st.step.skill}`
        : st.state === 'current' && isCiWait(p) ? `waiting for CI (${p.checks})` : undefined,
      isStale: (st.step.observe === 'verify.passed' && !!p.u.verify && !p.isVerified && !isRunning(st)) || isPrStale(st.step, p.u, p.g),
    })),
    notes,
    footer: isFinished || s.isLong || s.handoff
      ? { text: isFinished ? 'Unit finished.' : null, isRunning: s.handoff?.state === 'running' }
      : null,
  }
}

/**
 * Renders the Flow pane's view as plain text, for `/flow status`.
 *
 * @param v - The view.
 * @returns The pane's lines, joined.
 */
export function viewText(v: FlowView): string {
  const row = (r: FlowRow) => `${r.key.padEnd(keyWidth)}${r.value}`
  return [
    `${v.flow}  ${v.progress}`,
    '─'.repeat(36),
    ...(v.pending ? [v.pending] : []),
    ...v.issues.flatMap(is => [`#${is.number}`, ...(is.title ? [is.title] : [])]),
    '',
    ...(v.labels.length ? [row({ key: 'Labels', value: v.labels.join(', '), tone: 'text' })] : []),
    ...v.meta.map(row),
    '',
    ...v.steps.flatMap(st => [
      `${st.symbol} ${st.label}${st.isStale ? '  stale' : ''}`,
      ...(st.hint ? [`    ${st.hint}`] : []),
    ]),
    ...(v.notes.length ? ['', ...v.notes.map(row)] : []),
    ...(v.footer ? ['', `${v.footer.text ? `${v.footer.text} ` : ''}Continue in new session: /flow handoff`] : []),
  ].join('\n')
}
