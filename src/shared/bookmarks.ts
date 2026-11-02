/**
 * Bookmarks: the schema, the canonical key, and every decision that can be made
 * without touching a filesystem.
 *
 * Two properties drive the whole module:
 *
 * - **A page is identified by its canonical URL.** `bookmarkKey()` folds the two
 *   spellings of one page (`https://Example.com/` and `https://example.com`) into
 *   one string, so a star pressed twice is one record and a second press removes it
 *   rather than adding a duplicate. The id is derived from that key, which makes it
 *   deterministic: no clock, no counter, no id that drifts between launches.
 * - **Nothing here throws on bad input.** A bookmark file is user-editable, and the
 *   loader's job is to keep what still addresses a page and drop the rest — never to
 *   repair a URL into something the app would open.
 *
 * `node:test` holds this file to account, so it imports no Electron and reads no disk.
 */

import { hostOf } from './adblock.ts'
import { displayTitle, isNavigableUrl } from './math.ts'
import { DEFAULT_TILE_PARTITION, isTilePartition, normalizeTilePartition } from './session-partition.ts'

export interface BookmarkRecord {
  /** Deterministic: `bm-` plus a 32-bit hash of the canonical URL. */
  id: string
  /** The URL as the page reported it (trimmed, bounded), not the canonical key. */
  url: string
  /** The page title at the moment it was bookmarked; never empty. */
  title: string
  /**
   * Container the bookmark was captured from, when it was not the shared jar —
   * absent means the shared jar, the same absence rule `TileRecord.partition` uses.
   */
  container?: string
  /** ISO timestamp, kept on a re-bookmark so "when I saved this" does not move. */
  createdAt: string
}

export interface BookmarkStore {
  version: 1
  /**
   * Newest first. The order is the shelf's order and the tie-breaker in
   * `matchBookmarks()`, so it is data rather than a rendering choice.
   */
  bookmarks: BookmarkRecord[]
}

export const BOOKMARK_VERSION = 1
/** A convenience list, not a database: bounded like the pause list and the tiles. */
export const MAX_BOOKMARKS = 500
export const MAX_BOOKMARK_URL = 2048
export const MAX_BOOKMARK_TITLE = 200
/** Larger than any honest file of 500 records; a bigger one is not ours. */
export const MAX_BOOKMARK_BYTES = 1024 * 1024

export function emptyBookmarkStore(): BookmarkStore {
  return { version: BOOKMARK_VERSION, bookmarks: [] }
}

/**
 * The canonical form of a URL, or `''` when the app could not open it again.
 *
 * `isNavigableUrl()` is the same gate the omnibox, the loader and the context menu
 * use, so a bookmark can never name a scheme no tile will load. Only `http(s)` has a
 * normal form worth folding: the host is case-insensitive, the default port is not
 * part of the identity, a fragment is a position inside a page rather than a page,
 * and a bare `/` is the root either way. A query string *is* kept — on most sites the
 * query is which page you are looking at. `file:`, `about:` and `data:` have no such
 * grammar, so only surrounding whitespace and the fragment are dropped.
 */
export function bookmarkKey(raw: string): string {
  const input = typeof raw === 'string' ? raw.trim() : ''
  if (!input || input.length > MAX_BOOKMARK_URL) return ''
  if (!isNavigableUrl(input)) return ''
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return ''
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`
  }
  const withoutFragment = input.split('#')[0]
  return withoutFragment ?? input
}

/** FNV-1a over the canonical key: stable across launches, platforms and processes. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function bookmarkId(key: string): string {
  return `bm-${fnv1a(key)}`
}

/**
 * An id no record in `records` uses.
 *
 * Two different URLs colliding in 32 bits is unlikely and still has an answer: the
 * second one takes a suffix. The order of the list decides which one is bare, which is
 * why the store keeps its records in one stable array.
 */
function uniqueId(records: BookmarkRecord[], key: string): string {
  const base = bookmarkId(key)
  if (!records.some((record) => record.id === base)) return base
  for (let suffix = 2; suffix <= records.length + 2; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!records.some((record) => record.id === candidate)) return candidate
  }
  return `${base}-${records.length + 1}`
}

/**
 * A container is a storage key, so only a well-formed non-default one is kept, and the
 * default is left implicit — a bookmark captured from the shared jar writes no field.
 */
function coerceContainer(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return undefined
  const normalized = normalizeTilePartition(raw)
  if (normalized === DEFAULT_TILE_PARTITION || !isTilePartition(normalized)) return undefined
  return normalized
}

function coerceStamp(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  return new Date().toISOString()
}

/**
 * The loader: keep what still addresses a page, drop the rest.
 *
 * A record whose URL no longer parses is dropped rather than repaired, and a second
 * record for a key already kept is dropped too — the file cannot contain two rows for
 * one page, so a hand-edited duplicate loses to the newer one (the array is newest
 * first). Titles are trimmed and bounded; a title-less record gets the host label the
 * tile chrome would show, so the shelf never renders an empty row.
 */
export function coerceBookmarkStore(value: unknown): BookmarkStore {
  const store = emptyBookmarkStore()
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  const list = record && Array.isArray(record.bookmarks) ? record.bookmarks : []
  const seen = new Set<string>()
  for (const entry of list.slice(0, MAX_BOOKMARKS)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const item = entry as Record<string, unknown>
    const url = typeof item.url === 'string' ? item.url.trim().slice(0, MAX_BOOKMARK_URL) : ''
    const key = bookmarkKey(url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, MAX_BOOKMARK_TITLE) : ''
    const bookmark: BookmarkRecord = {
      id: uniqueId(store.bookmarks, key),
      url,
      title: title || displayTitle('', url),
      createdAt: coerceStamp(item.createdAt),
    }
    const container = coerceContainer(item.container)
    if (container) bookmark.container = container
    store.bookmarks.push(bookmark)
  }
  return store
}

/** The record for a URL, or null. One lookup, so no caller invents its own rule. */
export function findBookmark(store: BookmarkStore, url: string): BookmarkRecord | null {
  const key = bookmarkKey(url)
  if (!key) return null
  return store.bookmarks.find((record) => bookmarkKey(record.url) === key) ?? null
}

export function isBookmarked(store: BookmarkStore, url: string): boolean {
  return findBookmark(store, url) !== null
}

export interface BookmarkInput {
  url: string
  title?: string
  container?: string
}

export interface BookmarkChange {
  store: BookmarkStore
  record: BookmarkRecord
  /** True when the change *added* the record; false when it removed one. */
  added: boolean
}

/**
 * Add a page, or refresh the title of one already kept.
 *
 * Re-bookmarking is not a duplicate: the title and the container are taken from the
 * page in front of the user, and `createdAt` stays put so the list does not reshuffle
 * every time a page is starred again. `null` means the URL is not something a tile
 * could load, or the list is full — both are refusals the caller reports, not errors
 * to swallow.
 */
export function addBookmark(
  store: BookmarkStore,
  input: BookmarkInput,
  now = new Date().toISOString(),
): BookmarkChange | null {
  const url = typeof input.url === 'string' ? input.url.trim().slice(0, MAX_BOOKMARK_URL) : ''
  const key = bookmarkKey(url)
  if (!key) return null
  const title =
    (typeof input.title === 'string' ? input.title.trim().slice(0, MAX_BOOKMARK_TITLE) : '') ||
    displayTitle('', url)
  const container = coerceContainer(input.container)
  const existing = store.bookmarks.find((record) => bookmarkKey(record.url) === key)
  if (existing) {
    const updated: BookmarkRecord = { ...existing, url, title }
    if (container) updated.container = container
    else delete updated.container
    return {
      store: {
        version: BOOKMARK_VERSION,
        bookmarks: store.bookmarks.map((record) => (record.id === existing.id ? updated : record)),
      },
      record: updated,
      added: false,
    }
  }
  if (store.bookmarks.length >= MAX_BOOKMARKS) return null
  const record: BookmarkRecord = { id: uniqueId(store.bookmarks, key), url, title, createdAt: now }
  if (container) record.container = container
  return {
    store: { version: BOOKMARK_VERSION, bookmarks: [record, ...store.bookmarks] },
    record,
    added: true,
  }
}

export function removeBookmark(store: BookmarkStore, id: string): { store: BookmarkStore; removed: boolean } {
  const kept = store.bookmarks.filter((record) => record.id !== id)
  return {
    store: { version: BOOKMARK_VERSION, bookmarks: kept },
    removed: kept.length !== store.bookmarks.length,
  }
}

/**
 * The star, the link menu and the shelf's remove button all mean this one thing:
 * if the page is kept, forget it; if it is not, keep it. `added` is the state the
 * caller should report, so a button never flips on a refusal.
 */
export function toggleBookmark(
  store: BookmarkStore,
  input: BookmarkInput,
  now = new Date().toISOString(),
): BookmarkChange | null {
  const existing = findBookmark(store, input.url)
  if (!existing) return addBookmark(store, input, now)
  return {
    store: {
      version: BOOKMARK_VERSION,
      bookmarks: store.bookmarks.filter((record) => record.id !== existing.id),
    },
    record: existing,
    added: false,
  }
}

/**
 * Omnibox suggestions.
 *
 * The dock paints these on its own keystrokes, so this stays a cheap linear scan over
 * at most `MAX_BOOKMARKS` rows. Ranking is deliberately coarse: a host or title that
 * *starts* with what was typed beats a host that merely contains it, which beats a
 * title match, which beats a hit anywhere in the URL. Ties go to the newer bookmark,
 * because the shelf is newest-first and the list the user sees should agree with it.
 */
export function matchBookmarks(store: BookmarkStore, query: string, limit = 6): BookmarkRecord[] {
  const needle = (typeof query === 'string' ? query : '').trim().toLowerCase()
  if (!needle) return []
  const scored: { record: BookmarkRecord; score: number; index: number }[] = []
  for (const [index, record] of store.bookmarks.entries()) {
    const title = record.title.toLowerCase()
    const host = (hostOf(record.url) ?? '').toLowerCase()
    const url = record.url.toLowerCase()
    let score = 0
    if (title.startsWith(needle) || host.startsWith(needle)) score = 4
    else if (host.includes(needle)) score = 3
    else if (title.includes(needle)) score = 2
    else if (url.includes(needle)) score = 1
    if (score === 0) continue
    scored.push({ record, score, index })
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.record)
}
