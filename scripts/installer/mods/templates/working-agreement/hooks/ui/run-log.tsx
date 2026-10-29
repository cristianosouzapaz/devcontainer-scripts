import type { RenderChildren, RenderElement, ThemeKey } from 'claude-code'
import type { RunCommandStatus, RunCommandView, RunView } from '../../types'
import type { PaneElements } from './pane-sections'
import { drawRule } from './pane-layout'
import { commandSymbol, selectionCursor } from './symbols'
import { keyWidth, panePadding } from './theme'

type TextWrap = 'wrap' | 'truncate-middle' | 'truncate-end'
interface OutcomeLabel { text: string; color: ThemeKey }

const commandColors: Record<RunCommandStatus, ThemeKey> = { waiting: 'inactive', running: 'suggestion', passed: 'success', failed: 'error', timeout: 'error', cancelled: 'inactive' }

/**
 * Names the run kind consistently in section headers.
 * @param kind - The displayed run kind.
 * @returns Verify's name or the lowercase run label.
 */
function kindLabel(kind: RunView['kind']): string {
  return kind === 'Verify' ? 'Verify' : 'run'
}

/**
 * Names a command argument by its last path segment before any extension, so a runner and its test paths read as names.
 * @param arg - One argument; a flag, or one with no name left, is kept as given.
 * @returns The argument's short name.
 */
function nameArgument(arg: string): string {
  return arg.startsWith('-') ? arg : arg.split('/').filter(Boolean).pop()?.replace(/\..*$/, '') || arg
}

/**
 * Words a Verify command as its runner and the buckets it runs, since the full paths do not fit a pane row and stay in
 * the Run log.
 * @param argv - The command's argv.
 * @returns `runner: bucket, bucket`, or the runner alone.
 */
export function summarizeCommand(argv: string[]): string {
  const [runner = '', ...args] = argv.map(nameArgument)
  return args.length ? `${runner}: ${[...new Set(args)].join(', ')}` : runner
}

/**
 * Keeps the kind and details flexible while the elapsed time stays at the right edge.
 * @param elements - The pane's element table.
 * @param kind - The displayed run kind.
 * @param detail - The caller's header details, with their original layout.
 * @param elapsed - The formatted time, or null when no clock is shown.
 * @returns The shared header row.
 */
function runHeader({ Box, Text }: PaneElements, kind: RunView['kind'], detail: RenderChildren, elapsed: string | null): RenderElement {
  return <Box gap={1}>
    <Box flexGrow={1} minWidth={0}>
      <Box flexShrink={0}><Text weight="semibold" color="text">{kindLabel(kind)}</Text></Box>
      {detail}
    </Box>
    {elapsed !== null && <Box flexShrink={0}><Text color="inactive">{elapsed}</Text></Box>}
  </Box>
}

/**
 * Identifies commands whose name is muted in both live and history views.
 * @param status - The command's display status.
 * @returns Whether the command is waiting or cancelled.
 */
function isInactiveCommand(status: RunCommandStatus): boolean {
  return status === 'waiting' || status === 'cancelled'
}

/**
 * Keeps completed command durations compact in the run log.
 * @param seconds - The elapsed seconds.
 * @returns The elapsed whole seconds with minutes when needed.
 */
function duration(seconds: number): string {
  const rounded = Math.floor(seconds)
  return rounded >= 60 ? `${Math.floor(rounded / 60)}m${String(rounded % 60).padStart(2, '0')}s` : `${rounded}s`
}

/**
 * Gives running commands a consistent elapsed-time clock.
 * @param seconds - The elapsed seconds.
 * @returns The minutes and zero-padded seconds.
 */
function clock(seconds: number): string {
  const rounded = Math.floor(seconds)
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`
}

/**
 * Preserves output line boundaries and distinguishes empty completed output from live silence.
 * @param elements - The pane's render elements.
 * @param output - The captured command output.
 * @param live - Whether the command is still producing output.
 * @returns The output rows with their gutter and wrapping policy.
 */
function outputRows({ Box, Text }: PaneElements, output: string, live = false): RenderElement {
  const lines = output ? output.split('\n') : live ? [] : ['(no output)']
  return <Box flexDirection="column">{lines.map(line => <Box>
    <Box width={2} flexShrink={0}><Text color="subtle">│ </Text></Box>
    <Text color={!live && (!line || !output) ? 'inactive' : 'text'} wrap={live ? 'truncate-end' : 'wrap'}>{line || ' '}</Text>
  </Box>)}</Box>
}

/**
 * Draws the live section using the same fixed parts and yielding context as Flow.
 * @param elements - The pane's element table.
 * @param run - Display-only live progress.
 * @returns The temporary section below the steps.
 */
export function drawLiveRun(elements: PaneElements, run: RunView): RenderElement {
  const { Box, Text } = elements
  const current = run.commands.find(command => command.status === 'running')
  // A Verify command comes from the config's runners; any other run shows the argv the agent gave.
  const commandLine = (command: RunCommandView): string => run.kind === 'Verify' ? summarizeCommand(command.argv) : command.argv.join(' ')
  return <Box flexDirection="column">
    {runHeader(elements, run.kind, null, clock(run.duration))}
    {run.commands.length === 1 ? <Text color="text" wrap="truncate-end">{commandLine(run.commands[0]!)}</Text>
      : run.commands.map(command => <Box gap={1}>
        <Box flexGrow={1} minWidth={0}>
          <Box width={2} flexShrink={0}><Text color={commandColors[command.status]}>{commandSymbol[command.status]} </Text></Box>
          <Text color={isInactiveCommand(command.status) ? 'inactive' : 'text'} wrap="truncate-end">{commandLine(command)}</Text>
        </Box>
        {command.status !== 'waiting' && <Box flexShrink={0}><Text color={command.status === 'running' ? 'text' : command.status === 'failed' || command.status === 'timeout' ? 'error' : 'inactive'}>
          {command.status === 'running' ? clock(command.duration) : command.status === 'timeout' ? 'timed out' : command.status === 'failed' ? command.outcome : command.status === 'cancelled' ? 'killed' : duration(command.duration)}
        </Text></Box>}
      </Box>)}
    {current && outputRows(elements, current.output, true)}
  </Box>
}

/**
 * Distinguishes recorded evidence from cancelled or invalidated runs in the log heading.
 * @param run - The displayed run.
 * @returns The outcome text and its display color.
 */
function runOutcome(run: RunView): OutcomeLabel {
  if (run.status === 'running') return { text: 'running', color: 'text' }
  if (run.status === 'tree changed') return { text: 'not recorded', color: 'warning' }
  if (run.status === 'cancelled') return { text: 'cancelled', color: 'inactive' }
  if (run.status === 'timed out') return { text: 'timed out', color: 'error' }
  if (run.kind === 'red' || run.kind === 'green') return { text: `${run.kind} recorded`, color: 'text' }
  return { text: run.status, color: run.status === 'failed' ? 'error' : 'text' }
}

/**
 * Marks unfinished or unrecorded runs explicitly in the run list.
 * @param run - The displayed run.
 * @returns The list label for the run's state or kind.
 */
function listName(run: RunView): string {
  return run.status === 'running' ? 'running' : run.status === 'tree changed' || run.status === 'cancelled' ? 'not recorded' : run.kind
}

/**
 * Keeps the run list's result meaningful across live, cancelled and recorded outcomes.
 * @param run - The displayed run.
 * @returns The result text for the run list.
 */
function listResult(run: RunView): string {
  if (run.status === 'running') return clock(run.duration)
  if (run.status === 'tree changed') return runOutcome(run).text
  if (run.kind === 'red' || run.kind === 'green') return run.status === 'cancelled' ? 'cancelled'
    : run.result ?? (run.status === 'timed out' ? 'timed out' : run.commands.find(command => command.status === 'failed')?.outcome ?? 'exit 0')
  return run.status
}

/**
 * Shows command progress, outcome and output with the run's evidence semantics.
 * @param elements - The pane's render elements.
 * @param command - The command's displayed state.
 * @param run - The enclosing run.
 * @param columns - The available body width.
 * @returns The command's run-log section.
 */
function commandBlock(elements: PaneElements, command: RunCommandView, run: RunView, columns: number): RenderElement {
  const { Box, Text } = elements
  const inactive = isInactiveCommand(command.status)
  const outcome = command.status === 'waiting' ? run.status === 'running' ? 'waiting' : 'not run'
    : command.status === 'cancelled' ? 'killed'
    : command.status === 'running' ? clock(command.duration)
    : command.status === 'timeout' ? command.outcome.replace('timed out after ', 'timed out · ')
    : `${command.outcome} · ${duration(command.duration)}`
  const outcomeColor = command.status === 'timeout' || command.status === 'failed' ? 'error'
    : command.status === 'running' ? 'text' : 'inactive'
  return <Box flexDirection="column" marginTop={1}>
    <Text color="subtle">{drawRule(columns)}</Text>
    <Box>
      <Box width={2} flexShrink={0}><Text color={commandColors[command.status]}>{commandSymbol[command.status]} </Text></Box>
      <Text weight={!inactive ? 'semibold' : undefined} color={inactive ? 'inactive' : 'text'} wrap="wrap">{command.argv.join(' ')}</Text>
    </Box>
    <Box paddingLeft={2}><Text color={outcomeColor}>{outcome}</Text></Box>
    {command.status !== 'waiting' && outputRows(elements, command.output)}
  </Box>
}

/**
 * Draws the live attempt and recorded history without interpreting command output.
 * @param elements - The pane's element table.
 * @param runs - The live or unrecorded attempt, then the latest recorded run of each kind.
 * @param selectedRunId - The selected run, if still present.
 * @param columns - The pane body width.
 * @param select - Changes the selected run.
 * @param openFlow - Returns to the Flow pane.
 * @returns The Run log pane.
 */
export function renderRunLog(elements: PaneElements, runs: RunView[], selectedRunId: string | undefined, columns: number, select: (id: string) => void, openFlow: () => void): RenderElement {
  const { Box, Text, Button } = elements
  const selected = runs.find(run => run.runId === selectedRunId) ?? runs[0]
  const keyed = (key: string, value: string, color: ThemeKey = 'text', wrap: TextWrap = 'wrap') => <Box>
    <Box width={keyWidth} flexShrink={0}><Text color="inactive">{key}</Text></Box>
    <Text color={color} wrap={wrap}>{value}</Text>
  </Box>
  const fill = { width: columns, paddingX: panePadding.x, paddingTop: panePadding.top }
  if (!selected) return <Box {...fill}><Text color="inactive">No run yet.</Text></Box>
  const outcome = runOutcome(selected)
  return <Box flexDirection="column" {...fill}>
    {runs.length > 1 && <Box flexDirection="column">
      {runs.map((run, index) => <Box gap={1}>
        <Box flexGrow={1} minWidth={0}>
          <Box width={2} flexShrink={0}><Text color="suggestion">{run === selected ? `${selectionCursor} ` : '  '}</Text></Box>
          <Button key={String(index + 1)} hotkey={String(index + 1)} plain onPress={() => select(run.runId)}>
            <Text color="text" weight={run === selected ? 'semibold' : undefined}>{listName(run)}</Text><Text color="inactive" wrap="truncate-end"> · {listResult(run)}</Text>
          </Button>
        </Box>
        <Box flexShrink={0}><Text color="inactive">{run.tree.slice(0, 7)}</Text></Box>
      </Box>)}
      <Box marginY={1}><Text color="subtle">{drawRule(columns)}</Text></Box>
    </Box>}
    {runHeader(elements, selected.kind, [
      <Box flexShrink={0}><Text color="inactive"> · </Text></Box>,
      <Text color={outcome.color}>{outcome.text}</Text>,
    ], selected.commands.length > 0 ? selected.status === 'running' ? clock(selected.duration) : duration(selected.duration) : null)}
    <Box flexDirection="column">
      {selected.kind === 'Verify' && selected.selection && keyed('Selection', selected.selection, 'text', 'truncate-end')}
      {keyed('Tree', selected.tree.slice(0, 7))}
      {selected.cwd && keyed('Cwd', selected.cwd, 'text', 'truncate-middle')}
      {selected.status === 'tree changed' && keyed('Changed', selected.changed?.join(', ') || 'tree or base unavailable/changed', 'warning')}
      {selected.log && keyed('File', selected.log, 'inactive')}
    </Box>
    {selected.commands.map(command => commandBlock(elements, command, selected, columns))}
    <Box flexDirection="column" marginTop={1}>
      <Text color="subtle">{drawRule(columns)}</Text>
      <Box gap={1}>
        <Text color="inactive" wrap="truncate-end">Home/End · PgUp/PgDn</Text>
        <Box flexGrow={1} />
        <Box flexShrink={0}><Button key="flow" label="Flow" onPress={openFlow} /></Box>
      </Box>
    </Box>
  </Box>
}
