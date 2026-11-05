/** What the claude arguments of a unit session depend on: its permission mode and whether it continues at a usage limit. */
export interface UnitArgsInput { mode: string; continueAtUsageLimit: boolean }

/**
 * Builds the claude arguments every unit session starts with, whether it starts, resumes or restarts on an escalation: its permission mode
 * and one session-only settings JSON that turns off the dialogs a setting can prevent, so a session nobody watches does not stall on them.
 * @param input - The permission mode the unit runs in and whether it continues at a usage limit.
 * @returns `--permission-mode`, `--settings` and `--disallowedTools`, in that order.
 */
export function unitArgs(input: UnitArgsInput): string[] {
  const settings = {
    // why: the auto-mode setup offer is a modal at start; its "Not now" also snoozes it for every session of the user.
    skillOverrides: { 'auto-mode-setup': 'off' },
    // why: a defaultMode set here stops the "make auto mode your default" nudge; it is the --permission-mode value, never a second source.
    permissions: { defaultMode: input.mode },
    // why: a suggested prompt shows as dimmed text in the input box, which reads as typed text to whoever drives the pane.
    promptSuggestionEnabled: false,
    // why: spinner tips change the pane's text while the unit works, which a pane reader would have to filter out.
    spinnerTipsEnabled: false,
    // why: the session quality survey takes a typed digit, so it can swallow the text sent to the unit.
    feedbackSurveyRate: 0,
    // why: the survey checks this variable too, and on paths the rate does not cover, such as the one after a compaction.
    env: { CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1' },
    // why: with no renderer set, a modal offers to try the fullscreen renderer; fullscreen also docks the mod's pane beside the transcript.
    tui: 'fullscreen',
    // why: at a usage limit, a modal asks whether to wait for the reset; the user's option answers it ahead.
    ...input.continueAtUsageLimit ? { autoContinueAtUsageLimit: true } : {},
  }
  // why: an AskUserQuestion dialog blocks the unit without a sign; a unit asks by ending its turn.
  return ['--permission-mode', input.mode, '--settings', JSON.stringify(settings), '--disallowedTools', 'AskUserQuestion']
}
