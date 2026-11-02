import { WORKSPACE_NAME_MAX } from './constants.ts'

/**
 * Workspace names become file names under the config directory, so the only
 * thing that reaches the filesystem is this allowlist: [a-z0-9._-], starting
 * with an alphanumeric, no `..`, bounded length.
 */
export function sanitizeWorkspaceName(raw: string): string {
  const collapsed = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, WORKSPACE_NAME_MAX)
    .replace(/[-.]+$/, '')
  return collapsed.includes('..') ? collapsed.replace(/\.{2,}/g, '.') : collapsed
}

export function isValidWorkspaceName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= WORKSPACE_NAME_MAX &&
    /^[a-z0-9][a-z0-9._-]*$/.test(name) &&
    !name.includes('..')
  )
}
