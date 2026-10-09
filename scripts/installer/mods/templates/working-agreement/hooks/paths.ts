function glob(pattern: string) {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*')
  return new RegExp(`^${re}$`)
}

/**
 * Tells whether a repository-relative path matches any of the globs.
 *
 * @param globs - Globs where `**` spans directories and `*` stays within one.
 * @param rel - The path, relative to the repository root.
 * @returns True on the first match.
 */
export const matches = (globs: string[], rel: string): boolean => globs.some(g => glob(g).test(rel))

/**
 * Resolves a path against a directory and folds its `.` and `..` parts, without touching the file system.
 *
 * @param path - An absolute or relative path.
 * @param cwd - The directory a relative path is read from.
 * @returns The absolute path.
 */
export function normalize(path: string, cwd: string): string {
  const abs = path.startsWith('/') ? path : `${cwd}/${path}`
  const out: string[] = []
  for (const part of abs.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * Reads an absolute path relative to the repository root.
 *
 * @param abs - The absolute, normalized path.
 * @param root - The repository root.
 * @returns The relative path, '' for the root itself, or null outside the repository.
 */
export function repoRelative(abs: string, root: string): string | null {
  if (abs === root) return ''
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null
}
