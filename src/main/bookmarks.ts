/**
 * The bookmarks file: one flat JSON document in the config root, written atomically.
 *
 * Two rules, both learned from the workspace store next door:
 *
 * - **A write is a temp file plus a `rename`**, so a crash mid-write cannot truncate a
 *   file that already held five hundred bookmarks.
 * - **There is one in-memory copy and one writer.** Every mutation mutates that copy
 *   and then rewrites the whole document. `write()` chains onto the previous write, so
 *   two presses in one frame cannot interleave their temp files — and a queued write
 *   takes its snapshot when it runs, not when it was enqueued, so the last write always
 *   carries the newest state.
 *
 * A mutation that cannot reach the disk **rolls the in-memory copy back**, so the
 * star's answer and the file agree. Reporting "saved" for a failed write is the one
 * lie this class exists to avoid.
 *
 * The store is read once, at boot, and kept: a context menu needs `has()` synchronously
 * to pick its label, and an await there would mean a menu that opens a frame late.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  MAX_BOOKMARK_BYTES,
  coerceBookmarkStore,
  emptyBookmarkStore,
  isBookmarked,
  removeBookmark,
  toggleBookmark,
} from '../shared/bookmarks.ts'
import type { BookmarkInput, BookmarkRecord, BookmarkStore } from '../shared/bookmarks.ts'

export interface BookmarkResult {
  ok: boolean
  /** The state the store reached: true when the page is now kept. */
  bookmarked?: boolean
  id?: string
  error?: string
}

export class BookmarkFile {
  readonly path: string
  private store: BookmarkStore = emptyBookmarkStore()
  private ready: Promise<void> | null = null
  private writing: Promise<unknown> = Promise.resolve()

  constructor(root: string) {
    this.path = join(root, 'bookmarks.json')
  }

  /** Read the file exactly once. Every mutation awaits this first. */
  load(): Promise<void> {
    this.ready ??= this.read()
    return this.ready
  }

  private async read(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8')
      if (raw.length > MAX_BOOKMARK_BYTES) {
        // Not ours, or not a bookmark file any more. Empty beats parsing 40 MB.
        console.error(`[bookmarks] bookmarks.json is ${raw.length} bytes, over the ${MAX_BOOKMARK_BYTES} cap — ignored`)
        return
      }
      this.store = coerceBookmarkStore(JSON.parse(raw))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // A missing file is the first run. Anything else is worth a line, and both
      // answer an empty list rather than blocking the app on a broken convenience.
      if (code !== 'ENOENT') console.error('[bookmarks] could not read bookmarks.json:', error)
    }
  }

  /** What main holds, newest first. A copy: a caller cannot mutate the store. */
  list(): BookmarkRecord[] {
    return this.store.bookmarks.map((record) => ({ ...record }))
  }

  count(): number {
    return this.store.bookmarks.length
  }

  /** The menu label's question, answered without an await. */
  has(url: string): boolean {
    return isBookmarked(this.store, url)
  }

  find(id: string): BookmarkRecord | null {
    return this.store.bookmarks.find((record) => record.id === id) ?? null
  }

  /**
   * Keep the page, or forget it if it is already kept. `added` comes back as the
   * state the store reached, so the star paints what happened rather than what it
   * asked for.
   */
  async toggle(input: BookmarkInput): Promise<BookmarkResult> {
    await this.load()
    const change = toggleBookmark(this.store, input)
    if (!change) return { ok: false, error: 'this address cannot be opened again, so it cannot be bookmarked' }
    const previous = this.store
    this.store = change.store
    const written = await this.write()
    if (!written.ok) {
      this.store = previous
      return { ok: false, error: written.error }
    }
    return { ok: true, bookmarked: change.added, id: change.record.id }
  }

  /** The shelf's remove button. A missing id is a no-op reported honestly. */
  async remove(id: string): Promise<BookmarkResult> {
    await this.load()
    const next = removeBookmark(this.store, id)
    if (!next.removed) return { ok: false, error: 'that bookmark is already gone' }
    const previous = this.store
    this.store = next.store
    const written = await this.write()
    if (!written.ok) {
      this.store = previous
      return { ok: false, error: written.error }
    }
    return { ok: true, bookmarked: false }
  }

  private write(): Promise<{ ok: boolean; error?: string }> {
    const run = this.writing.then(async (): Promise<{ ok: boolean; error?: string }> => {
      // Snapshot inside the queued step: a write that waits behind another one must
      // persist the store as it is when it runs, not as it was when it was queued.
      const snapshot = JSON.stringify(this.store, null, 2)
      try {
        await mkdir(dirname(this.path), { recursive: true })
        const tmp = `${this.path}.${process.pid}.tmp`
        await writeFile(tmp, `${snapshot}\n`, 'utf8')
        await rename(tmp, this.path)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: `bookmarks.json could not be written: ${String(error)}` }
      }
    })
    // The chain must not carry a rejection forward, or one failed write would poison
    // every later one; the failure is reported through the returned promise instead.
    this.writing = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
