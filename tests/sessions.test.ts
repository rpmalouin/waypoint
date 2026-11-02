import assert from 'node:assert/strict'
import test from 'node:test'
import { COOKIE_FLUSH_BUDGET_MS, clearContainerStorage, flushCookieStores } from '../src/main/sessions.ts'
import type { CookieFlusher, FlusherFor, StorageClearer } from '../src/main/sessions.ts'

type Behaviour = 'ok' | 'reject' | 'hang'

/** A flusher whose stores answer as told and record what was asked of them. */
function fakeFlusher(calls: string[], behaviour: Record<string, Behaviour> = {}): FlusherFor {
  return (partition: string): CookieFlusher => {
    const mode = behaviour[partition] ?? 'ok'
    return {
      cookies: {
        flushStore: async (): Promise<void> => {
          calls.push(partition)
          if (mode === 'reject') throw new Error('store is read-only')
          // A store that never answers: the shape a cold or wedged volume takes.
          if (mode === 'hang') await new Promise<void>(() => {})
        },
      },
    }
  }
}

test('the default budget is a couple of seconds, not a wait without end', () => {
  assert.ok(COOKIE_FLUSH_BUDGET_MS > 0 && COOKIE_FLUSH_BUDGET_MS <= 5000)
})

test('flushes every persistent partition once and skips in-memory ones', async () => {
  const calls: string[] = []
  const report = await flushCookieStores(
    ['persist:main', 'temp:private', 'persist:main', 'persist:work'],
    fakeFlusher(calls),
  )
  assert.deepEqual(calls, ['persist:main', 'persist:work'], 'each store flushed once, in-memory skipped')
  assert.deepEqual(report.flushed, ['persist:main', 'persist:work'])
  assert.deepEqual(report.timedOut, [])
  assert.deepEqual(report.failed, [])
})

test('a rejecting store is reported, never thrown', async () => {
  const calls: string[] = []
  const report = await flushCookieStores(
    ['persist:main', 'persist:broken'],
    fakeFlusher(calls, { 'persist:broken': 'reject' }),
  )
  assert.deepEqual(report.flushed, ['persist:main'])
  assert.deepEqual(report.failed, ['persist:broken'])
  assert.deepEqual(report.timedOut, [])
})

test('one hanging store cannot hold the quit open past the budget', async () => {
  const calls: string[] = []
  const startedAt = Date.now()
  const report = await flushCookieStores(
    ['persist:main', 'persist:slow'],
    fakeFlusher(calls, { 'persist:slow': 'hang' }),
    120,
  )
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 1000, `expected a bounded wait, waited ${elapsed}ms`)
  assert.deepEqual(report.flushed, ['persist:main'], 'the fast store still flushed')
  assert.deepEqual(report.timedOut, ['persist:slow'])
  assert.ok(report.elapsedMs <= elapsed + 5)
})

test('the budget covers the whole set, not each partition', async () => {
  const calls: string[] = []
  const startedAt = Date.now()
  await flushCookieStores(
    ['persist:a', 'persist:b', 'persist:c'],
    fakeFlusher(calls, { 'persist:a': 'hang', 'persist:b': 'hang', 'persist:c': 'hang' }),
    150,
  )
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 450, `three hung stores must not cost 3x the budget (waited ${elapsed}ms)`)
})

test('nothing persistent to flush resolves at once and touches no store', async () => {
  const calls: string[] = []
  const report = await flushCookieStores(['temp:private', 'private'], fakeFlusher(calls))
  assert.deepEqual(calls, [])
  assert.deepEqual(report.flushed, [])
  assert.deepEqual(report.timedOut, [])
  assert.deepEqual(report.failed, [])
  assert.ok(report.elapsedMs < 50)
})

test('an empty set is not an error', async () => {
  const report = await flushCookieStores([], fakeFlusher([]))
  assert.deepEqual(report.flushed, [])
  assert.deepEqual(report.failed, [])
  assert.deepEqual(report.timedOut, [])
})

// ------------------------------------------------------- clearing a container

/** A clearer that reports which calls it had to make, and can refuse or hang. */
function fakeClearer(
  calls: string[],
  behaviour: Behaviour = 'ok',
): (partition: string) => StorageClearer {
  return (partition: string): StorageClearer => {
    const note = (step: string): Promise<void> => {
      calls.push(`${partition}:${step}`)
      if (behaviour === 'reject') return Promise.reject(new Error('store is read-only'))
      if (behaviour === 'hang') return new Promise<void>(() => {})
      return Promise.resolve()
    }
    return {
      clearStorageData: () => note('data'),
      clearCache: () => note('cache'),
    }
  }
}

test('clearing a container wipes its storage and then its cache', async () => {
  const calls: string[] = []
  const report = await clearContainerStorage('persist:work', fakeClearer(calls))
  assert.equal(report.ok, true, report.error ?? '')
  assert.deepEqual(calls, ['persist:work:data', 'persist:work:cache'], 'storage first, cache second')
})

test('the shared jar is refused, so one press cannot sign out every tile', async () => {
  const calls: string[] = []
  const report = await clearContainerStorage('persist:main', fakeClearer(calls))
  assert.equal(report.ok, false)
  assert.match(report.error ?? '', /shared session/)
  assert.deepEqual(calls, [], 'a refused clear must not touch the store')
})

test('a malformed partition is refused before any store is resolved', async () => {
  const calls: string[] = []
  const report = await clearContainerStorage('persist:../../etc', fakeClearer(calls))
  assert.equal(report.ok, false)
  assert.deepEqual(calls, [])
})

test('a rejecting clear is reported, never thrown', async () => {
  const report = await clearContainerStorage('persist:work', fakeClearer([], 'reject'))
  assert.equal(report.ok, false)
  assert.match(report.error ?? '', /read-only/)
})

test('a hanging clear is bounded by its budget', async () => {
  const startedAt = Date.now()
  const report = await clearContainerStorage('persist:work', fakeClearer([], 'hang'), 120)
  const elapsed = Date.now() - startedAt
  assert.equal(report.ok, false)
  assert.match(report.error ?? '', /took longer/)
  assert.ok(elapsed < 1000, `expected a bounded wait, waited ${elapsed}ms`)
})
