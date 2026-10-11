function compileGlob(pattern: string): RegExp {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*')
  return new RegExp(`^${source}$`)
}

/**
 * Tells whether a repository-relative path matches any of the globs.
 *
 * @param globs - Globs where `**` spans directories and `*` stays within one.
 * @param relativePath - The path, relative to the repository root.
 * @returns True on the first match.
 */
export const isPathMatched = (globs: string[], relativePath: string): boolean => globs.some(glob => compileGlob(glob).test(relativePath))

/**
 * Resolves a path against a directory and folds its `.` and `..` parts, without touching the file system.
 *
 * @param path - An absolute or relative path.
 * @param cwd - The directory a relative path is read from.
 * @returns The absolute path.
 */
export function normalizePath(path: string, cwd: string): string {
  const absolutePath = path.startsWith('/') ? path : `${cwd}/${path}`
  const kept: string[] = []
  for (const part of absolutePath.split('/')) {
    if (part === '..') kept.pop()
    else if (part && part !== '.') kept.push(part)
  }
  return `/${kept.join('/')}`
}

/**
 * Reads an absolute path relative to the repository root.
 *
 * @param absolutePath - The absolute, normalized path.
 * @param root - The repository root.
 * @returns The relative path, '' for the root itself, or null outside the repository.
 */
export function toRepoRelative(absolutePath: string, root: string): string | null {
  if (absolutePath === root) return ''
  return absolutePath.startsWith(`${root}/`) ? absolutePath.slice(root.length + 1) : null
}
