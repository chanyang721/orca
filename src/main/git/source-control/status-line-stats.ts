import type { GitStatusEntry } from '../../../shared/git-status-types'
import { collectGitStatusLineStatInputs } from '../../../shared/git-status-line-stat-inputs'
import {
  applyLineStats,
  collectUntrackedAdditions,
  parseNumstat,
  type GitLineStats
} from '../../../shared/git-uncommitted-line-stats'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { extractExecError } from '../exec-error'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'

// Windows sharing locks (an app holding its database or log open) make Git abort the whole
// unstaged pass with "cannot hash <path>"; exclude each such path so the other rows still count.
const UNREADABLE_PATH_PATTERN = /^fatal: cannot hash (.+)$/m
// One path per failed run; bound the retries when many files are held open.
const MAX_UNREADABLE_PATH_EXCLUSIONS = 8

type NumstatPass = { stats: Map<string, GitLineStats>; complete: boolean }

export function parseUnreadableNumstatPath(stderr: string): string | null {
  return UNREADABLE_PATH_PATTERN.exec(stderr)?.[1]?.trimEnd() || null
}

async function runNumstat(
  worktreePath: string,
  cached: boolean,
  options: GitRuntimeOptions = {}
): Promise<NumstatPass | null> {
  const excluded: string[] = []
  for (;;) {
    try {
      const { stdout } = await gitExecFileAsync(
        [
          '-c',
          'core.quotePath=false',
          '-c',
          'diff.autoRefreshIndex=false',
          'diff',
          '-z',
          ...(cached ? ['--cached'] : []),
          '--numstat',
          '-M',
          ...(excluded.length > 0
            ? ['--', ...excluded.map((excludedPath) => `:(top,exclude,literal)${excludedPath}`)]
            : [])
        ],
        {
          ...gitReadOptionsForWorktree(worktreePath, options),
          env: gitOptionalLocksDisabledEnv()
        }
      )
      // Excluded rows stay uncounted, so a partial pass must not be cached.
      return { stats: parseNumstat(stdout), complete: excluded.length === 0 }
    } catch (error) {
      // Propagate cancellation; ordinary numstat failures may degrade to uncounted rows.
      if (options.signal?.aborted) {
        throw error
      }
      const unreadablePath = parseUnreadableNumstatPath(extractExecError(error).stderr)
      if (
        unreadablePath === null ||
        excluded.includes(unreadablePath) ||
        excluded.length >= MAX_UNREADABLE_PATH_EXCLUSIONS
      ) {
        // null marks the pass incomplete and uncacheable; an empty map would imply success.
        return null
      }
      excluded.push(unreadablePath)
    }
  }
}

/** Returns false when a numstat pass failed, so callers skip caching it. */
export async function attachLineStats(
  worktreePath: string,
  entries: GitStatusEntry[],
  options: GitRuntimeOptions = {}
): Promise<boolean> {
  if (entries.length === 0) {
    return true
  }
  const { hasStaged, hasUnstaged, untrackedPaths } = collectGitStatusLineStatInputs(entries)
  const emptyStats = new Map<string, GitLineStats>()
  const skippedPass: NumstatPass = { stats: emptyStats, complete: true }
  const [stagedStats, unstagedStats, untrackedStats] = await Promise.all([
    hasStaged ? runNumstat(worktreePath, true, options) : Promise.resolve(skippedPass),
    hasUnstaged ? runNumstat(worktreePath, false, options) : Promise.resolve(skippedPass),
    // Node reads need host paths even when Git runs in WSL.
    collectUntrackedAdditions(
      resolveWorktreeFilesystemPath(worktreePath, options),
      untrackedPaths,
      options.signal
    )
  ])
  for (const entry of entries) {
    const area = entry.area
    applyLineStats(
      entry,
      area === 'staged'
        ? (stagedStats?.stats ?? emptyStats).get(entry.path)
        : area === 'unstaged'
          ? (unstagedStats?.stats ?? emptyStats).get(entry.path)
          : untrackedStats.get(entry.path)
    )
  }
  return stagedStats?.complete === true && unstagedStats?.complete === true
}
