/**
 * The application menu, and the menus a right-click opens.
 *
 * **Why the Edit items are not `role:`s.** Electron installs a default menu, so this app has always
 * had an Edit menu with `role: 'copy'`, `role: 'paste'` and friends in it. Those items were inert:
 * the role handlers act on the focused **BrowserWindow**, and the shell here is a `BaseWindow` with
 * child `WebContentsView`s, so there is no BrowserWindow to act on and the click goes nowhere.
 * Measured on Electron 45.2.1 — invoking the real `role: 'copy'` item's click handler with a tile
 * focused and text selected left the clipboard untouched; a custom item calling
 * `webContents.copy()` moved it. So every window-scoped command below calls the focused
 * webContents itself, and only app-scoped roles (`about`, `hide`, `quit`) stay roles.
 *
 * `webContents.getFocusedWebContents()` is the right target for a keyboard shortcut, because the
 * document that should receive ⌘C is whichever one has focus — a tile's page, the omnibox, a
 * sidebar field. A context menu is the other way round: it acts on the view that was right-clicked,
 * which is not necessarily the focused one, so it carries its own target.
 */

import { app, clipboard, Menu, webContents } from 'electron'
import type { BaseWindow, MenuItemConstructorOptions, WebContents } from 'electron'
import type { ContextMenuEntry, ContextMenuParams } from '../shared/context-menu.ts'
import { SEARCH_TEMPLATE } from '../shared/math.ts'

/** The focused document, whichever view owns it. Null while a renderer is being torn down. */
function focusedContents(): WebContents | null {
  const contents = webContents.getFocusedWebContents()
  return contents && !contents.isDestroyed() ? contents : null
}

/**
 * The application menu as data, so a test can read it without a running NSMenu.
 *
 * Deliberately no File, View or Window menu: Electron's default View menu binds ⌘0/⌘+/⌘− to the
 * guest page's zoom factor, which fights the canvas's own zoom model, and its File menu binds ⌘W to
 * closing the only window there is. Losing those accelerators is the point, not an oversight.
 */
export function appMenuTemplate(appName: string): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => focusedContents()?.undo() },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => focusedContents()?.redo() },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => focusedContents()?.cut() },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => focusedContents()?.copy() },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => focusedContents()?.paste() },
        {
          label: 'Paste and Match Style',
          accelerator: 'Shift+CmdOrCtrl+V',
          click: () => focusedContents()?.pasteAndMatchStyle(),
        },
        { label: 'Delete', click: () => focusedContents()?.delete() },
        { type: 'separator' },
        {
          label: 'Select All',
          accelerator: 'CmdOrCtrl+A',
          click: () => focusedContents()?.selectAll(),
        },
      ],
    },
  ]
}

export function setupApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(app.name)))
}

export interface ContextMenuContext {
  /** The view the menu acts on: the tile that was right-clicked, or the chrome view. */
  target: WebContents
  /**
   * Open a URL as a new tile. The caller closes over the container, so a link from a
   * `persist:work` tile lands in that jar — the same rule a `target=_blank` popup follows.
   */
  openUrl: (url: string) => void
  /**
   * Keep or forget a link's address. Main owns the bookmark file, so this is a
   * closure over it rather than a channel: the entry the user pressed names a URL and
   * a title, and nothing about the file crosses into the renderer.
   */
  bookmarkUrl: (url: string, title: string) => void
}

/**
 * Turn entries into a Menu. The edit commands act on `target` rather than on the focused
 * webContents, because a right-click can arrive on a view that never took keyboard focus.
 */
export function contextMenu(
  entries: ContextMenuEntry[],
  params: ContextMenuParams,
  ctx: ContextMenuContext,
): Menu {
  const selection = (params.selectionText ?? '').trim()
  const link = typeof params.linkURL === 'string' ? params.linkURL : ''
  // A link's own text names the bookmark; a link with no text (an image, an icon) keeps
  // the address's host label, which is what the shelf would show anyway.
  const linkTitle = (params.linkText ?? '').trim()
  const edit = (run: (target: WebContents) => void): (() => void) => () => {
    if (ctx.target.isDestroyed()) return
    run(ctx.target)
  }

  const template: MenuItemConstructorOptions[] = entries.map((entry) => {
    if (entry.kind === 'separator') return { type: 'separator' }
    const item = { label: entry.label, enabled: entry.enabled }
    switch (entry.id) {
      case 'open-link':
        return { ...item, click: () => ctx.openUrl(link) }
      case 'copy-link':
        return {
          ...item,
          click: () => {
            // The clipboard API is promise-based in this Electron: an unawaited write is a write
            // that may not have happened, and an unawaited read compares a Promise.
            void clipboard
              .writeText(link)
              .catch((error: unknown) => console.error('[menu] copy link failed:', error))
          },
        }
      case 'bookmark-link':
        return { ...item, click: () => ctx.bookmarkUrl(link, linkTitle) }
      case 'undo':
        return { ...item, click: edit((target) => target.undo()) }
      case 'redo':
        return { ...item, click: edit((target) => target.redo()) }
      case 'cut':
        return { ...item, click: edit((target) => target.cut()) }
      case 'copy':
        return { ...item, click: edit((target) => target.copy()) }
      case 'paste':
        return { ...item, click: edit((target) => target.paste()) }
      case 'paste-and-match-style':
        return { ...item, click: edit((target) => target.pasteAndMatchStyle()) }
      case 'delete':
        return { ...item, click: edit((target) => target.delete()) }
      case 'select-all':
        return { ...item, click: edit((target) => target.selectAll()) }
      case 'search-selection':
        return {
          ...item,
          click: () => ctx.openUrl(SEARCH_TEMPLATE + encodeURIComponent(selection)),
        }
      default:
        return item
    }
  })

  return Menu.buildFromTemplate(template)
}

/** Pop a built menu, or log why it could not. A menu nobody sees is worth a line. */
export function popupMenu(menu: Menu, window: BaseWindow): void {
  if (window.isDestroyed()) return
  try {
    menu.popup({ window })
  } catch (error) {
    console.error('[menu] popup failed:', error)
  }
}
