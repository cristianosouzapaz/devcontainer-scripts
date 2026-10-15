import type { UnexplainedWrites, Unit } from './records'

/** Holds a working tree as git reads it: each file that differs from HEAD with its content hash, '' for one the tree lacks. */
export interface DirtyFiles {
  [path: string]: string
}

/**
 * Holds what changed in the tree between two reads: the tree recorded and the one read now, null where git could not read
 * it, the files no allowed write explains, and whether the tree went unread while a step held writes back.
 */
export interface TreeChange {
  before: DirtyFiles | null
  after: DirtyFiles | null
  strays: string[]
  isUnchecked: boolean
}

// Stands for the content of a file that matched HEAD, which a restore brings back by making it clean again.
const cleanMark = 'clean'

/**
 * Lists the files changed between two reads: those whose content differs between the two trees, leaving out a file made
 * to match HEAD again, since a write back to HEAD adds no change.
 *
 * @param before - The tree recorded.
 * @param after - The tree read now.
 * @returns The repo-relative paths.
 */
export const listTreeChanges = (before: DirtyFiles, after: DirtyFiles): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => path in after && before[path] !== after[path])

/**
 * Lists the recorded unexplained files that still differ from what they held before they changed.
 *
 * @param unexplained - The record.
 * @param tree - The tree now, or null when git cannot read it, which leaves every file unrestored.
 * @returns The repo-relative paths.
 */
export function listUnrestored(unexplained: UnexplainedWrites, tree: DirtyFiles | null): string[] {
  const files = Object.entries(unexplained.files)
  if (!tree) return files.map(([path]) => path)
  return files.filter(([path, held]) => (held === cleanMark ? path in tree : tree[path] !== held)).map(([path]) => path)
}

/**
 * Records what changed between two reads on a unit: the unexplained files join the record with what they held before,
 * keeping an earlier record's, and every recorded file restored leaves it.
 *
 * @param unit - The unit.
 * @param change - What the call changed.
 * @returns The unit as changed.
 */
export function applyTreeChange(unit: Unit, change: TreeChange): Unit {
  const { before, after, strays, isUnchecked } = change
  const { unexplained: recorded, ...rest } = unit
  const files = { ...Object.fromEntries(strays.map(path => [path, before?.[path] ?? cleanMark])), ...recorded?.files }
  const unrestored = after ? listUnrestored({ files }, after) : Object.keys(files)
  const isStillUnchecked = isUnchecked || !!recorded?.isUnchecked
  return {
    ...rest,
    ...(unrestored.length || isStillUnchecked
      ? { unexplained: { files: Object.fromEntries(unrestored.map(path => [path, files[path]!])), ...(isStillUnchecked ? { isUnchecked: true as const } : {}) } }
      : {}),
  }
}
