/** GitHub's closing keywords, each followed by one issue as `#n`, `owner/repo#n` or the issue URL. */
const closingReference = /(?<![\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\s*:\s*|\s+)(?:#(\d+)|([\w.-]+\/[\w.-]+)#(\d+)|https?:\/\/[^\s/]+\/([\w.-]+\/[\w.-]+)\/issues\/(\d+))(?![\w-])/gi

/**
 * Reads the issues a PR body closes under GitHub's keyword grammar, as GitHub links them only for PRs into the default branch.
 * @param body - The PR body.
 * @param repository - The PR's repository as `owner/name`; references to another repository are left out.
 * @returns The closed issue numbers, ascending and without duplicates.
 */
export function parseClosingIssues(body: string, repository: string): number[] {
  const issues = [...body.matchAll(closingReference)].flatMap(([, local, named, qualified, linked, url]) => {
    const target = named ?? linked
    const number = Number(local ?? qualified ?? url)
    return (target === undefined || target.toLowerCase() === repository.toLowerCase()) && Number.isSafeInteger(number) && number > 0 ? [number] : []
  })
  return [...new Set(issues)].sort((a, b) => a - b)
}
