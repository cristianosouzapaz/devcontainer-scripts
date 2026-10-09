import type { Gh } from './records'

/** The last GitHub reachability probe and when it ran. */
export interface GhCache { at: number; gh: Gh }

/** A running handoff: when it started, the document it wrote, and how its /handoff turn ended. */
export interface Handoff {
  at: number; isFinished: boolean; path: string | null
  armed: boolean; ended: (reason: string) => void
}

/** A verify run launched in a herdr pane and not yet reported: the id of its exit marker and the tree it started on. */
export interface HerdrRun { id: string; tree: string }

/** What the hooks share between events for the life of one module load. */
export interface Runtime {
  /** Every skill started in the current turn: a nested skill (generate-pr inside create-pr) does not end the one that started it. */
  turnSkills: string[]
  ghCache: GhCache | null
  permissionMode: string | null
  prCheckedAt: number
  handoffTokens: number
  handoff: Handoff | null
  /** Verify runs launched in a herdr pane and not yet reported, by pane id. */
  herdrVerify: Record<string, HerdrRun>
  /** Marker ids a herdr verify run already reported; one never counts again. */
  herdrConsumed: Set<string>
  lock: Promise<unknown>
}

/** The hooks' shared in-memory state; a reload evaluates the module again, so it starts over. */
export const runtime: Runtime = {
  turnSkills: [],
  ghCache: null,
  permissionMode: null,
  prCheckedAt: 0,
  handoffTokens: 150000,
  handoff: null,
  herdrVerify: {},
  herdrConsumed: new Set(),
  lock: Promise.resolve(),
}

/**
 * Runs record read-modify-writes one at a time: session and unit records are written whole, so parallel tool calls take turns here.
 *
 * @param fn - The read-modify-write to run.
 * @returns What `fn` resolves to.
 */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = runtime.lock.then(fn)
  runtime.lock = p.catch(() => undefined)
  return p
}
