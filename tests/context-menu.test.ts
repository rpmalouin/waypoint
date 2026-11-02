import assert from 'node:assert/strict'
import test from 'node:test'
import { buildContextMenu } from '../src/shared/context-menu.ts'
import type { ContextMenuEntry } from '../src/shared/context-menu.ts'

const ids = (entries: ContextMenuEntry[]): string[] =>
  entries.flatMap((entry) => (entry.kind === 'command' ? [entry.id] : []))

const separators = (entries: ContextMenuEntry[]): number =>
  entries.filter((entry) => entry.kind === 'separator').length

const entry = (entries: ContextMenuEntry[], id: string): ContextMenuEntry | null =>
  entries.find((item) => item.kind === 'command' && item.id === id) ?? null

test('a right-click with nothing to offer builds no menu at all', () => {
  assert.deepEqual(buildContextMenu({}), [])
  assert.deepEqual(buildContextMenu({ linkURL: '', isEditable: false, selectionText: '   ' }), [])
})

test('a link offers all three halves, and nothing else', () => {
  const entries = buildContextMenu({ linkURL: 'https://example.com/a' })
  assert.deepEqual(ids(entries), ['open-link', 'copy-link', 'bookmark-link'])
  assert.equal(separators(entries), 0, 'one block needs no rule inside it')
})

test('the bookmark entry is a toggle, and its label says which half it is', () => {
  const offer = entry(buildContextMenu({ linkURL: 'https://example.com/a' }), 'bookmark-link')
  const remove = entry(buildContextMenu({ linkURL: 'https://example.com/a', bookmarked: true }), 'bookmark-link')
  assert.equal(offer?.kind === 'command' ? offer.label : '', 'Bookmark Link')
  assert.equal(remove?.kind === 'command' ? remove.label : '', 'Remove Bookmark')
  // The id does not change with the label: main has one handler and one meaning.
  assert.equal(remove?.kind === 'command' ? remove.id : '', 'bookmark-link')
})

test('a link the app cannot load offers nothing', () => {
  // isNavigableUrl is the same gate the omnibox and the registry use: promising a tile that
  // cannot exist is worse than an empty menu.
  for (const linkURL of ['javascript:alert(1)', 'mailto:someone@example.com', 'not a url']) {
    assert.deepEqual(buildContextMenu({ linkURL }), [], linkURL)
  }
})

test('an editable field offers the edit commands, grouped', () => {
  const entries = buildContextMenu({ isEditable: true })
  assert.deepEqual(ids(entries), [
    'undo',
    'redo',
    'cut',
    'copy',
    'paste',
    'paste-and-match-style',
    'delete',
    'select-all',
  ])
  // Three blocks → two rules, and no rule at either end.
  assert.equal(separators(entries), 2)
  assert.notEqual(entries[0]?.kind, 'separator')
  assert.notEqual(entries[entries.length - 1]?.kind, 'separator')
})

test("Chromium's editFlags decide enabled, and only when it says false", () => {
  const entries = buildContextMenu({
    isEditable: true,
    editFlags: { canUndo: false, canCut: false, canPaste: true },
  })
  const enabled = (id: string): boolean | undefined => {
    const found = entry(entries, id)
    return found && found.kind === 'command' ? found.enabled : undefined
  }
  assert.equal(enabled('undo'), false)
  assert.equal(enabled('cut'), false)
  assert.equal(enabled('paste'), true)
  assert.equal(enabled('copy'), true, 'a missing flag is a yes, not a no')

  const noFlags = buildContextMenu({ isEditable: true })
  assert.equal(
    ids(noFlags).every((id) => {
      const found = entry(noFlags, id)
      return found && found.kind === 'command' ? found.enabled : false
    }),
    true,
    'no flags means every command is offered',
  )
})

test('a read-only selection offers copy and the search that follows it', () => {
  const entries = buildContextMenu({ selectionText: '  some words  ' })
  assert.deepEqual(ids(entries), ['copy', 'search-selection'])
  assert.equal(separators(entries), 1)
})

test('an editable field with a selection is an edit block, not a search', () => {
  // The selection inside a field belongs to that field: searching for what you were about to
  // overwrite is not what the pointer asked for.
  const entries = buildContextMenu({ isEditable: true, selectionText: 'text' })
  assert.equal(ids(entries).includes('search-selection'), false)
  assert.equal(ids(entries).includes('paste'), true)
})

test('a link with a selection keeps both blocks, separated once each', () => {
  const entries = buildContextMenu({ linkURL: 'https://example.com', selectionText: 'words' })
  assert.deepEqual(ids(entries), ['open-link', 'copy-link', 'bookmark-link', 'copy', 'search-selection'])
  // link block | copy | search → two rules: one between blocks, one inside the selection pair.
  assert.equal(separators(entries), 2)
  assert.notEqual(entries[entries.length - 1]?.kind, 'separator')
})

test('no block arrangement leaves a dangling or doubled rule', () => {
  const cases = [
    { linkURL: 'https://example.com' },
    { isEditable: true },
    { selectionText: 'x' },
    { linkURL: 'https://example.com', isEditable: true },
    { linkURL: 'https://example.com', selectionText: 'x' },
    { linkURL: 'https://example.com', isEditable: true, selectionText: 'x' },
  ]
  for (const params of cases) {
    const entries = buildContextMenu(params)
    assert.notEqual(entries[0]?.kind, 'separator', JSON.stringify(params))
    assert.notEqual(entries[entries.length - 1]?.kind, 'separator', JSON.stringify(params))
    for (let index = 1; index < entries.length; index += 1) {
      const doubled = entries[index]?.kind === 'separator' && entries[index - 1]?.kind === 'separator'
      assert.equal(doubled, false, `two rules in a row for ${JSON.stringify(params)}`)
    }
  }
})
