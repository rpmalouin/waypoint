import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_BOOKMARKS,
  MAX_BOOKMARK_TITLE,
  addBookmark,
  bookmarkId,
  bookmarkKey,
  coerceBookmarkStore,
  emptyBookmarkStore,
  findBookmark,
  isBookmarked,
  matchBookmarks,
  removeBookmark,
  toggleBookmark,
} from '../src/shared/bookmarks.ts'
import type { BookmarkStore } from '../src/shared/bookmarks.ts'

const AT = '2026-11-02T12:00:00.000Z'

const urls = (store: BookmarkStore): string[] => store.bookmarks.map((record) => record.url)

test('the canonical key folds the spellings of one page', () => {
  // Scheme and host are case-insensitive, the default port is not part of the identity,
  // and a bare `/` is the root either way.
  assert.equal(bookmarkKey('https://Example.COM/'), 'https://example.com')
  assert.equal(bookmarkKey('  https://example.com  '), 'https://example.com')
  assert.equal(bookmarkKey('https://example.com:443'), 'https://example.com')
  assert.equal(bookmarkKey('HTTPS://example.com/path'), 'https://example.com/path')
})

test('a fragment is a position in a page, not a page', () => {
  assert.equal(bookmarkKey('https://example.com/a#section'), 'https://example.com/a')
  assert.equal(bookmarkKey('https://example.com/a#one'), bookmarkKey('https://example.com/a#two'))
})

test('a query is part of which page you are looking at', () => {
  assert.equal(bookmarkKey('https://example.com/s?q=1'), 'https://example.com/s?q=1')
  assert.notEqual(bookmarkKey('https://example.com/s?q=1'), bookmarkKey('https://example.com/s?q=2'))
})

test('an address no tile could open has no key', () => {
  for (const url of ['', '   ', 'javascript:alert(1)', 'mailto:a@b.c', 'not a url', 'https://example.com/' + 'x'.repeat(3000)]) {
    assert.equal(bookmarkKey(url), '', url.slice(0, 40))
  }
})

test('schemes with no host grammar keep their own identity', () => {
  assert.equal(bookmarkKey('about:blank'), 'about:blank')
  assert.equal(bookmarkKey('file:///tmp/a.html'), 'file:///tmp/a.html')
  const data = 'data:text/html,<h1>hi</h1>'
  assert.equal(bookmarkKey(data), data)
})

test('the id is derived from the key, so two presses agree', () => {
  const key = bookmarkKey('https://example.com/page')
  assert.equal(bookmarkId(key), bookmarkId(key))
  assert.match(bookmarkId(key), /^bm-[0-9a-f]{8}$/)
  assert.notEqual(bookmarkId(key), bookmarkId(bookmarkKey('https://example.com/other')))
  // Determinism across processes is the point: this is a fixed vector, not a timestamp.
  assert.equal(bookmarkId(bookmarkKey('https://example.com/page')), bookmarkId('https://example.com/page'))
})

test('adding a page puts it at the front and names it', () => {
  const change = addBookmark(emptyBookmarkStore(), { url: 'https://example.com/a' }, AT)
  assert.ok(change)
  assert.equal(change.added, true)
  assert.equal(change.record.title, 'example.com', 'a title-less record still says something')
  assert.equal(change.record.createdAt, AT)
  assert.equal(change.record.id, bookmarkId(bookmarkKey('https://example.com/a')))
  assert.equal(change.store.bookmarks.length, 1)
  assert.equal(change.store.version, 1)
})

test('bookmarking the same page twice is one row, and the newer title wins', () => {
  const first = addBookmark(emptyBookmarkStore(), { url: 'https://example.com/a', title: 'One' }, AT)
  assert.ok(first)
  const second = addBookmark(first.store, { url: 'https://Example.com/a#top', title: 'Two' }, '2026-11-03T00:00:00.000Z')
  assert.ok(second)
  assert.equal(second.added, false)
  assert.equal(second.store.bookmarks.length, 1)
  assert.equal(second.record.title, 'Two')
  assert.equal(second.record.createdAt, AT, 'when it was saved does not move')
})

test('a trailing slash is a different resource, so it is a different bookmark', () => {
  // `/a` and `/a/` are two URLs a server may answer differently; folding them would make
  // one of the two unreachable from the shelf.
  assert.notEqual(bookmarkKey('https://example.com/a'), bookmarkKey('https://example.com/a/'))
  assert.equal(bookmarkKey('https://example.com/'), bookmarkKey('https://example.com'))
})

test('a container is kept only when it is a real, non-default one', () => {
  const shared = addBookmark(emptyBookmarkStore(), { url: 'https://example.com/a', container: 'persist:main' }, AT)
  assert.ok(shared)
  assert.equal('container' in shared.record, false, 'the shared jar writes no field')

  const work = addBookmark(emptyBookmarkStore(), { url: 'https://example.com/a', container: 'persist:work' }, AT)
  assert.ok(work)
  assert.equal(work.record.container, 'persist:work')

  const junk = addBookmark(emptyBookmarkStore(), { url: 'https://example.com/a', container: '../../etc' }, AT)
  assert.ok(junk)
  assert.equal('container' in junk.record, false, 'a malformed container is dropped, never repaired')
})

test('re-bookmarking refreshes the container, and a default one clears it', () => {
  const work = addBookmark(emptyBookmarkStore(), { url: 'https://example.com/a', container: 'persist:work' }, AT)
  assert.ok(work)
  const cleared = addBookmark(work.store, { url: 'https://example.com/a', title: 'A' }, AT)
  assert.ok(cleared)
  assert.equal('container' in cleared.record, false)
})

test('toggle is the star: keep, then forget', () => {
  const added = toggleBookmark(emptyBookmarkStore(), { url: 'https://example.com/a', title: 'A' }, AT)
  assert.ok(added)
  assert.equal(added.added, true)
  assert.equal(isBookmarked(added.store, 'https://example.com/a'), true)

  const removed = toggleBookmark(added.store, { url: 'https://example.com/a#top' }, AT)
  assert.ok(removed)
  assert.equal(removed.added, false)
  assert.deepEqual(urls(removed.store), [])
  assert.equal(isBookmarked(removed.store, 'https://example.com/a'), false)
})

test('the list is full at the cap, and a refusal is null', () => {
  let store = emptyBookmarkStore()
  for (let index = 0; index < MAX_BOOKMARKS; index += 1) {
    const change = addBookmark(store, { url: `https://example.com/p${index}` }, AT)
    assert.ok(change, `record ${index}`)
    store = change.store
  }
  assert.equal(store.bookmarks.length, MAX_BOOKMARKS)
  assert.equal(addBookmark(store, { url: 'https://example.com/one-too-many' }, AT), null)
  // Refreshing one already in the list is not blocked by the cap.
  assert.ok(addBookmark(store, { url: 'https://example.com/p0', title: 'again' }, AT))
})

test('a URL the app cannot open is refused, not stored', () => {
  assert.equal(addBookmark(emptyBookmarkStore(), { url: 'javascript:alert(1)' }, AT), null)
  assert.equal(toggleBookmark(emptyBookmarkStore(), { url: 'mailto:a@b.c' }, AT), null)
})

test('findBookmark answers by canonical key, so a fragment still matches', () => {
  const added = addBookmark(emptyBookmarkStore(), { url: 'https://example.com/a', title: 'A' }, AT)
  assert.ok(added)
  assert.equal(findBookmark(added.store, 'https://example.com/a#x')?.title, 'A')
  assert.equal(findBookmark(added.store, 'https://example.com/b'), null)
  assert.equal(findBookmark(added.store, 'nothing'), null)
})

test('remove takes one record and says whether it took anything', () => {
  const added = addBookmark(emptyBookmarkStore(), { url: 'https://example.com/a' }, AT)
  assert.ok(added)
  const id = added.record.id
  const first = removeBookmark(added.store, id)
  assert.equal(first.removed, true)
  assert.deepEqual(first.store.bookmarks, [])
  assert.equal(removeBookmark(first.store, id).removed, false, 'a second press is a no-op, not a throw')
})

test('the loader keeps what still addresses a page and drops the rest', () => {
  const store = coerceBookmarkStore({
    version: 1,
    bookmarks: [
      { id: 'bm-ignoreme', url: 'https://example.com/a', title: '  A  ', createdAt: AT },
      { url: 'https://example.com/a', title: 'duplicate key' },
      { url: 'javascript:alert(1)', title: 'no' },
      { url: 'https://example.com/b', title: 'b'.repeat(MAX_BOOKMARK_TITLE + 50) },
      { url: 'https://example.com/c', container: 'persist:work' },
      { url: 'https://example.com/d', container: 'persist:main' },
      { nope: true },
    ],
  })
  assert.deepEqual(urls(store), ['https://example.com/a', 'https://example.com/b', 'https://example.com/c', 'https://example.com/d'])
  assert.equal(store.bookmarks[0]?.title, 'A')
  assert.equal(store.bookmarks[0]?.id, bookmarkId(bookmarkKey('https://example.com/a')), 'the id is recomputed, never trusted')
  assert.equal(store.bookmarks[1]?.title.length, MAX_BOOKMARK_TITLE)
  assert.equal(store.bookmarks[2]?.container, 'persist:work')
  assert.equal(store.bookmarks[3] !== undefined && 'container' in store.bookmarks[3], false)
  assert.equal(store.bookmarks[0]?.createdAt, AT)
})

test('a junk file is an empty list, not a throw', () => {
  for (const value of [null, undefined, 42, 'text', [], { bookmarks: 'no' }]) {
    assert.deepEqual(coerceBookmarkStore(value), emptyBookmarkStore(), JSON.stringify(value ?? null))
  }
  assert.equal(coerceBookmarkStore({ bookmarks: [{ url: 'https://a.example' }] }).bookmarks.length, 1)
})

test('the loader stops at the cap rather than trusting the file', () => {
  const rows = Array.from({ length: MAX_BOOKMARKS + 25 }, (_value, index) => ({ url: `https://example.com/p${index}` }))
  assert.equal(coerceBookmarkStore({ bookmarks: rows }).bookmarks.length, MAX_BOOKMARKS)
})

test('suggestions rank a host prefix above a substring, and stop at the limit', () => {
  let store = emptyBookmarkStore()
  for (const [url, title] of [
    ['https://example.com/docs', 'Reference'],
    ['https://example.org/notes', 'Example notes'],
    ['https://other.test/x', 'Something about example'],
    ['https://news.test/y', 'Unrelated'],
  ] as const) {
    const change = addBookmark(store, { url, title }, AT)
    assert.ok(change)
    store = change.store
  }
  const matches = matchBookmarks(store, 'example')
  // Newest first among equals, and the host-prefix rows outrank the title hit.
  assert.deepEqual(
    matches.map((record) => record.url),
    ['https://example.org/notes', 'https://example.com/docs', 'https://other.test/x'],
  )
  assert.deepEqual(matchBookmarks(store, 'nothing here'), [])
  assert.deepEqual(matchBookmarks(store, '  '), [], 'an empty query suggests nothing')
  assert.equal(matchBookmarks(store, 'example', 1).length, 1)
  assert.equal(matchBookmarks(store, 'examp').length, 3, 'both hosts and the title hit')
})

test('a suggestion for a URL fragment finds the page', () => {
  const added = addBookmark(emptyBookmarkStore(), { url: 'https://example.com/deep/page', title: 'Deep' }, AT)
  assert.ok(added)
  assert.equal(matchBookmarks(added.store, 'deep/page')[0]?.title, 'Deep')
})
