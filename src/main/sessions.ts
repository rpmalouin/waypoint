import { DEFAULT_TILE_PARTITION, isPersistentPartition, isTilePartition } from '../shared/session-partition.ts'

/**
 * Chromium writes cookies to disk on its own schedule, not when the last tab
 * closes. Without an explicit flush a quit can lose the login the user just
 * completed — the session looks fine for the whole run and is gone on restart.
 *
 * Two rules shape this module:
 *
 * 1. **The app must never hang on a flush.** `flushStore()` has no timeout of its
 *    own and talks to a SQLite store on a possibly-cold volume, so the whole set
 *    shares ONE budget. A store that hangs is reported and the quit proceeds;
 *    the alternative is an app that will not close.
 * 2. **It must not throw or reject.** Every call site is inside a quit path,
 *    where an unhandled rejection is logged and then the process leaves anyway.
 *    Failures come back in the report.
 *
 * The Electron dependency is injected (`flusherFor`) rather than imported: that
 * keeps this module loadable under `node --test`, so the budget and the failure
 * paths are covered by unit tests instead of only by a live quit.
 */

/** One budget for the whole set, not per partition. */
export const COOKIE_FLUSH_BUDGET_MS = 2000

/** The one member of Electron's `Session` this module needs. */
export interface CookieFlusher {
  cookies: { flushStore: () => Promise<void> }
}

export type FlusherFor = (partition: string) => CookieFlusher

export interface FlushReport {
  /** Partitions whose store confirmed the flush. */
  flushed: string[]
  /** Partitions that had not answered when the budget ran out. */
  timedOut: string[]
  /** Partitions whose flush rejected. */
  failed: string[]
  /** Milliseconds spent waiting, for the caller's log line. */
  elapsedMs: number
}

/**
 * Flush every persistent partition in `partitions` and report what happened.
 * Non-`persist:` names are skipped (nothing on disk), duplicates are collapsed
 * so a shared session is not flushed twice, and the result is never rejected.
 */
export async function flushCookieStores(
  partitions: Iterable<string>,
  flusherFor: FlusherFor,
  budgetMs = COOKIE_FLUSH_BUDGET_MS,
): Promise<FlushReport> {
  const startedAt = Date.now()
  const report: FlushReport = { flushed: [], timedOut: [], failed: [], elapsedMs: 0 }
  const unique = [...new Set(partitions)].filter(isPersistentPartition)
  if (unique.length === 0) {
    report.elapsedMs = Date.now() - startedAt
    return report
  }

  const flushOne = async (partition: string): Promise<void> => {
    try {
      await flusherFor(partition).cookies.flushStore()
      report.flushed.push(partition)
    } catch {
      // A read-only or half-removed store: nothing to save, and not worth a
      // throw in the middle of a quit.
      report.failed.push(partition)
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), Math.max(1, budgetMs))
  })
  const settled = Promise.all(unique.map(flushOne)).then(() => 'settled' as const)

  const outcome = await Promise.race([settled, expired])
  if (timer !== null) clearTimeout(timer)

  if (outcome === 'expired') {
    for (const partition of unique) {
      if (report.flushed.includes(partition) || report.failed.includes(partition)) continue
      report.timedOut.push(partition)
    }
  }
  report.elapsedMs = Date.now() - startedAt
  return report
}

// --------------------------------------------------------- container clearing

/**
 * Clearing a container is the third thing a container needs and the only one that
 * destroys state, so it gets the same treatment as the flush: one budget, no throw,
 * and a refusal for the case that would be a mistake.
 *
 * Electron is injected (`clearerFor`) for the same reason the flusher is — the
 * budget and the failure paths are then covered by unit tests instead of only by a
 * live click.
 */

/** One budget for the whole clear, matching the flush's reasoning. */
export const CONTAINER_CLEAR_BUDGET_MS = 4000

/** The members of Electron's `Session` a clear needs. */
export interface StorageClearer {
  /** No options: every storage class for every origin in this session. */
  clearStorageData: () => Promise<void>
  clearCache: () => Promise<void>
}

export interface ClearReport {
  ok: boolean
  error?: string
  elapsedMs: number
}

/**
 * Wipe one container's cookies and site storage.
 *
 * The shared jar is refused. It is a valid partition and clearing it would "work",
 * which is exactly why the guard lives here rather than in the menu: one press in
 * a container panel must not sign the user out of every tile in the app. Deleting
 * the shared jar is a deliberate act, not a row in a list.
 */
export async function clearContainerStorage(
  partition: string,
  clearerFor: (partition: string) => StorageClearer,
  budgetMs = CONTAINER_CLEAR_BUDGET_MS,
): Promise<ClearReport> {
  const startedAt = Date.now()
  const elapsed = (): number => Date.now() - startedAt

  if (!isTilePartition(partition)) {
    return { ok: false, error: `"${partition}" is not a container`, elapsedMs: elapsed() }
  }
  if (partition === DEFAULT_TILE_PARTITION) {
    return {
      ok: false,
      error: 'the shared session is not cleared from here — it holds every default tile',
      elapsedMs: elapsed(),
    }
  }

  const clearer = clearerFor(partition)
  // The clear is not cancellable, so the race decides what is *reported*, not what
  // stops: a store that answers after the budget still ends up cleared.
  const work = (async (): Promise<ClearReport> => {
    await clearer.clearStorageData()
    await clearer.clearCache()
    return { ok: true, elapsedMs: 0 }
  })().catch((error: unknown): ClearReport => ({ ok: false, error: String(error), elapsedMs: 0 }))

  let timer: ReturnType<typeof setTimeout> | null = null
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), Math.max(1, budgetMs))
  })

  const outcome = await Promise.race([work, expired])
  if (timer !== null) clearTimeout(timer)

  if (outcome === 'expired') {
    return { ok: false, error: `clearing took longer than ${budgetMs}ms`, elapsedMs: elapsed() }
  }
  return { ...outcome, elapsedMs: elapsed() }
}
