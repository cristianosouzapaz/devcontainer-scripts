import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { env } from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const summaryTtlMs = "86400000";

function summarize(prompt: string): string {
  return Array.from(prompt.trim().replace(/\s*[\r\n]+\s*/g, " ")).slice(0, 60).join("");
}

/**
 * Whether `error` is an `Error` with its own `code` that is "ENOENT" (`herdr` missing)
 * or a number (`herdr` exited non-zero). Any other error returns false; the caller rethrows it.
 */
function isHerdrFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !Object.hasOwn(error, "code")) return false;
  const { code } = error as Error & { code: unknown };
  return code === "ENOENT" || typeof code === "number";
}

/**
 * Runs `herdr pane report-metadata` for the pane with the given source and arguments.
 * Rejects when `herdr` is missing or exits non-zero.
 */
async function report(paneId: string, source: string, args: string[]): Promise<void> {
  await execFileAsync("herdr", ["pane", "report-metadata", paneId, "--source", source, ...args]);
}

/**
 * Pi extension that shows the session in its Herdr pane. Registers handlers only
 * when `HERDR_ENV` is "1" and `HERDR_PANE_ID` is set. Reports the first prompt as
 * the pane summary and the context usage after each turn, and clears both on
 * shutdown. The context row is skipped while usage is unknown. A missing `herdr` or a
 * non-zero exit is swallowed so it never fails Pi; any other error is rethrown.
 *
 * @param pi Pi's extension API.
 */
export default function (pi: ExtensionAPI): void {
  const paneId = env["HERDR_PANE_ID"];
  if (env["HERDR_ENV"] !== "1" || !paneId) return;

  const stopSummary = pi.on("input", async (event) => {
    stopSummary();
    try {
      await report(paneId, "pi-summary", ["--token", `summary=${summarize(event.text)}`, "--ttl-ms", summaryTtlMs]);
    } catch (error) {
      // The summary is decoration: an unreachable Herdr must not fail the prompt.
      if (!isHerdrFailure(error)) throw error;
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (usage === undefined || usage.percent === null) return; // Unknown right after compaction: keep the last value.
    const tokens = usage.tokens === null ? "" : ` (${Math.round(usage.tokens / 1000)}k)`;
    try {
      await report(paneId, "pi-context", ["--token", `context=⛁ ${Math.round(usage.percent)}%${tokens}`]);
    } catch (error) {
      // The context row is decoration: an unreachable Herdr must not fail the turn.
      if (!isHerdrFailure(error)) throw error;
    }
  });

  pi.on("session_shutdown", async () => {
    for (const [source, token] of [["pi-summary", "summary"], ["pi-context", "context"]] as const) {
      try {
        await report(paneId, source, ["--clear-token", token]);
      } catch (error) {
        // Herdr may have stopped before Pi finishes shutting down.
        if (!isHerdrFailure(error)) throw error;
      }
    }
  });
}
