// Windows sharing locks make `git diff --numstat` abort on one file; the other rows must still count.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../shared/git-status-types'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: vi.fn(),
  gitOptionalLocksDisabledEnv: (env: NodeJS.ProcessEnv = process.env) => env,
  gitStreamStdout: vi.fn()
}))

import {
  attachLineStats,
  clearRememberedUnreadableNumstatPaths,
  parseUnreadableNumstatPath
} from './source-control/status-line-stats'
import { GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS } from '../../shared/git-status-line-stats-cache'

const WORKTREE = '/repo'
const LOCKED = 'data/app state.json'

function unstaged(entryPath: string): GitStatusEntry {
  return { path: entryPath, area: 'unstaged', status: 'modified' }
}

function cannotHash(entryPath: string): Error {
  return Object.assign(new Error('Command failed: git diff'), {
    stdout: '',
    stderr: `error: open("${entryPath}"): Permission denied\nfatal: cannot hash ${entryPath}\n`
  })
}

function excludedPaths(call: unknown[]): string[] {
  const argv = call[0] as string[]
  return argv.filter((arg) => arg.startsWith(':(top,exclude,literal)'))
}

describe('unstaged line stats with a file another process holds open', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    clearRememberedUnreadableNumstatPaths()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the locked path from Git stderr', () => {
    expect(
      parseUnreadableNumstatPath(
        `error: open("${LOCKED}"): Permission denied\nfatal: cannot hash ${LOCKED}\n`
      )
    ).toBe(LOCKED)
    expect(parseUnreadableNumstatPath('fatal: not a git repository')).toBeNull()
  })

  it('excludes the locked path and counts the remaining rows without caching', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(cannotHash(LOCKED))
      .mockResolvedValueOnce({ stdout: '3\t1\tsrc/a.ts\0', stderr: '' })
    const entries = [unstaged('src/a.ts'), unstaged(LOCKED)]

    const complete = await attachLineStats(WORKTREE, entries)

    expect(complete).toBe(false)
    expect(entries[0]).toMatchObject({ added: 3, removed: 1 })
    expect(entries[1].added).toBeUndefined()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(excludedPaths(gitExecFileAsyncMock.mock.calls[0])).toEqual([])
    expect(excludedPaths(gitExecFileAsyncMock.mock.calls[1])).toEqual([
      `:(top,exclude,literal)${LOCKED}`
    ])
  })

  it('accumulates one exclusion per locked file', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(cannotHash('a.db'))
      .mockRejectedValueOnce(cannotHash('b.log'))
      .mockResolvedValueOnce({ stdout: '1\t0\tsrc/a.ts\0', stderr: '' })
    const entries = [unstaged('src/a.ts'), unstaged('a.db'), unstaged('b.log')]

    await attachLineStats(WORKTREE, entries)

    expect(entries[0]).toMatchObject({ added: 1, removed: 0 })
    expect(excludedPaths(gitExecFileAsyncMock.mock.calls[2])).toEqual([
      ':(top,exclude,literal)a.db',
      ':(top,exclude,literal)b.log'
    ])
  })

  it('stops retrying when Git reports a path it already excluded', async () => {
    gitExecFileAsyncMock.mockRejectedValue(cannotHash(LOCKED))
    const entries = [unstaged('src/a.ts'), unstaged(LOCKED)]

    const complete = await attachLineStats(WORKTREE, entries)

    expect(complete).toBe(false)
    expect(entries[0].added).toBeUndefined()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('bounds the retries when many files are locked', async () => {
    let next = 0
    gitExecFileAsyncMock.mockImplementation(async () => {
      throw cannotHash(`locked-${next++}.db`)
    })

    const complete = await attachLineStats(WORKTREE, [unstaged('src/a.ts')])

    expect(complete).toBe(false)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(9)
  })

  it('does not retry other numstat failures', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('Command failed'), { stderr: 'fatal: bad object HEAD\n' })
    )

    const complete = await attachLineStats(WORKTREE, [unstaged('src/a.ts')])

    expect(complete).toBe(false)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('starts the next poll with the remembered exclusion while the file stays locked', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(cannotHash(LOCKED))
      .mockResolvedValue({ stdout: '3\t1\tsrc/a.ts\0', stderr: '' })
    await attachLineStats(WORKTREE, [unstaged('src/a.ts'), unstaged(LOCKED)])
    gitExecFileAsyncMock.mockClear()

    const entries = [unstaged('src/a.ts'), unstaged(LOCKED)]
    const complete = await attachLineStats(WORKTREE, entries)

    expect(complete).toBe(false)
    expect(entries[0]).toMatchObject({ added: 3, removed: 1 })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(excludedPaths(gitExecFileAsyncMock.mock.calls[0])).toEqual([
      `:(top,exclude,literal)${LOCKED}`
    ])
  })

  it('re-probes remembered paths after the line-stats cache TTL so a released file counts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    gitExecFileAsyncMock
      .mockRejectedValueOnce(cannotHash(LOCKED))
      .mockResolvedValue({ stdout: '3\t1\tsrc/a.ts\0', stderr: '' })
    await attachLineStats(WORKTREE, [unstaged('src/a.ts'), unstaged(LOCKED)])
    gitExecFileAsyncMock.mockClear()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: `3\t1\tsrc/a.ts\u00002\t0\t${LOCKED}\u0000`,
      stderr: ''
    })

    vi.setSystemTime(GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS)
    const entries = [unstaged('src/a.ts'), unstaged(LOCKED)]
    const complete = await attachLineStats(WORKTREE, entries)

    expect(complete).toBe(true)
    expect(entries[1]).toMatchObject({ added: 2, removed: 0 })
    expect(excludedPaths(gitExecFileAsyncMock.mock.calls[0])).toEqual([])
  })

  it('keeps remembered paths per worktree', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(cannotHash(LOCKED))
      .mockResolvedValue({ stdout: '', stderr: '' })
    await attachLineStats(WORKTREE, [unstaged(LOCKED)])
    gitExecFileAsyncMock.mockClear()

    await attachLineStats('/other', [unstaged('src/a.ts')])

    expect(excludedPaths(gitExecFileAsyncMock.mock.calls[0])).toEqual([])
  })
})
