/**
 * What a right-click offers, as data.
 *
 * Electron hands the main process a `context-menu` event with a params object describing what the
 * pointer was over — a link, an editable field, a selection — and somebody has to decide what goes
 * in the menu. That decision is the interesting part and it is pure, so it lives here and
 * `src/main/menu.ts` turns the answer into MenuItems.
 *
 * Two things this module deliberately does not do: it never imports Electron, so `node:test` can
 * hold it to account; and it never returns a leading, trailing or doubled separator, because a menu
 * with a dangling rule in it is how "we built something wrong" looks to a user.
 */

import { isNavigableUrl } from './math.ts'

/** The subset of Electron's `ContextMenuParams` this app reads. */
export interface ContextMenuParams {
  /** `''` when the pointer was not over a link. */
  linkURL?: string
  /** What the link's own text says. The link menu uses it as the bookmark's title. */
  linkText?: string
  /**
   * Whether the app already keeps this link's address. Supplied by main from the
   * bookmark file, because the shop window's label has to say what the press will do:
   * "Bookmark Link" and "Remove Bookmark" are the same toggle in two states.
   */
  bookmarked?: boolean
  /** True inside an input, textarea or contenteditable region. */
  isEditable?: boolean
  /** What the page reports as selected, untrimmed. */
  selectionText?: string
  /** Chromium's own answer to "would this command do anything here". */
  editFlags?: EditFlags
}

export interface EditFlags {
  canUndo?: boolean
  canRedo?: boolean
  canCut?: boolean
  canCopy?: boolean
  canPaste?: boolean
  canDelete?: boolean
  canSelectAll?: boolean
}

export type ContextMenuCommand =
  | 'open-link'
  | 'copy-link'
  | 'bookmark-link'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'paste-and-match-style'
  | 'delete'
  | 'select-all'
  | 'search-selection'

export type ContextMenuEntry =
  | { kind: 'separator' }
  | { kind: 'command'; id: ContextMenuCommand; label: string; enabled: boolean }

const command = (id: ContextMenuCommand, label: string, enabled = true): ContextMenuEntry => ({
  kind: 'command',
  id,
  label,
  enabled,
})

/**
 * The entries for one right-click, in order.
 *
 * An empty array is a real answer: main must not pop an empty menu, and a right-click on a spot
 * with nothing to offer should do nothing rather than open a box with no items in it.
 */
export function buildContextMenu(params: ContextMenuParams): ContextMenuEntry[] {
  const link = typeof params.linkURL === 'string' ? params.linkURL : ''
  const selection = (params.selectionText ?? '').trim()
  const flags = params.editFlags ?? {}
  const blocks: ContextMenuEntry[][] = []

  // A link always offers all three halves, and only when the app could actually load
  // it — a `javascript:` or `mailto:` target in a sandboxed tile is not something to
  // promise. The bookmark item is a toggle, so its label states which half it is.
  if (link && isNavigableUrl(link)) {
    blocks.push([
      command('open-link', 'Open Link in New Tile'),
      command('copy-link', 'Copy Link Address'),
      command('bookmark-link', params.bookmarked === true ? 'Remove Bookmark' : 'Bookmark Link'),
    ])
  }

  if (params.isEditable) {
    blocks.push([
      command('undo', 'Undo', flags.canUndo !== false),
      command('redo', 'Redo', flags.canRedo !== false),
    ])
    blocks.push([
      command('cut', 'Cut', flags.canCut !== false),
      command('copy', 'Copy', flags.canCopy !== false),
      command('paste', 'Paste', flags.canPaste !== false),
      command('paste-and-match-style', 'Paste and Match Style', flags.canPaste !== false),
      command('delete', 'Delete', flags.canDelete !== false),
    ])
    blocks.push([command('select-all', 'Select All', flags.canSelectAll !== false)])
  } else if (selection) {
    // Read-only text: copying is the only edit, and searching is what a browser is for.
    blocks.push([command('copy', 'Copy')])
    blocks.push([command('search-selection', 'Search DuckDuckGo')])
  }

  return blocks.flatMap((block, index) =>
    index === 0 ? block : [{ kind: 'separator' } as ContextMenuEntry, ...block],
  )
}
