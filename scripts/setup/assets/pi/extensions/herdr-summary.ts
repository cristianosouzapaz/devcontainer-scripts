import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TTL_MS = "86400000";

function summarize(prompt: string): string {
  return Array.from(prompt.trim().replace(/\s*[\r\n]+\s*/g, " ")).slice(0, 60).join("");
}

async function report(paneId: string, args: string[]): Promise<void> {
  await execFileAsync("herdr", ["pane", "report-metadata", paneId, "--source", "pi-summary", ...args]);
}

export default function (pi: ExtensionAPI) {
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !paneId) return;

  let reported = false;

  pi.on("input", async (event) => {
    if (reported) return;
    reported = true;
    try {
      await report(paneId, ["--token", `summary=${summarize(event.text)}`, "--ttl-ms", TTL_MS]);
    } catch {
      // The summary is decoration: an unreachable Herdr must not fail the prompt.
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      await report(paneId, ["--clear-token", "summary"]);
    } catch {
      // Herdr may have stopped before Pi finishes shutting down.
    }
  });
}
