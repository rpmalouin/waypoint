import { BaseWindow, WebContentsView, app, ipcMain, screen, session } from 'electron'
import type { ContextMenuParams, IpcMainEvent, IpcMainInvokeEvent, Menu, WebContents } from 'electron'
import { join } from 'node:path'
import {
  AUTOSAVE_DEBOUNCE_MS,
  CANVAS_BG,
  CANVAS_PARTITION,
  DEFAULT_WINDOW_H,
  DEFAULT_WINDOW_W,
  DOCK_BOTTOM,
  DOCK_HEIGHT,
  DOCK_MARGIN,
  DOCK_PARTITION,
  DOCK_WIDTH,
  HUD_COMPACT_HEIGHT,
  HUD_COMPACT_WIDTH,
  HUD_MARGIN,
  MIN_WINDOW_H,
  MIN_WINDOW_W,
  OVERLAY_PARTITION,
  QUIT_COLLECT_BUDGET_MS,
  SIDEBAR_PARTITION,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_SLIDE_MS,
  SIDEBAR_WIDTH,
} from '../shared/constants.ts'
import { CH } from '../shared/channels.ts'
import { buildContextMenu } from '../shared/context-menu.ts'
import type { ContextMenuEntry, ContextMenuParams as AppMenuParams } from '../shared/context-menu.ts'
import { intersects, normalizeUrl } from '../shared/math.ts'
import { DEFAULT_TILE_PARTITION, isTilePartition, parseOmniboxInput } from '../shared/session-partition.ts'
import { initialPanMode, reducePanMode } from '../shared/pan-mode.ts'
import type { PanModeEvent, PanModeState } from '../shared/pan-mode.ts'
import { sanitizeWorkspaceName, isValidWorkspaceName } from '../shared/workspace-name.ts'
import { coerceTheme, resolveTheme } from '../shared/theme.ts'
import type { WorkspaceTheme } from '../shared/theme.ts'
import type {
  ActionResult,
  CanvasRpc,
  CanvasSnapshot,
  CanvasStatus,
  CanvasTool,
  ChromeRegion,
  FrameRecord,
  OverlayAction,
  OverlayConfig,
  OverlayMode,
  Point,
  Rect,
  TileCommand,
  TileRecord,
  TileSummary,
  WorkspaceState,
} from '../shared/types.ts'
import { TileRegistry } from './registry.ts'
import { Adblocker } from './adblock.ts'
import type { BlockerStats } from './adblock.ts'
import { contextMenu, popupMenu, setupApplicationMenu } from './menu.ts'
import { CosmeticFilter } from './cosmetic.ts'
import type { CosmeticStats } from './cosmetic.ts'
import { hostOf } from '../shared/adblock.ts'
import { clearContainerStorage, flushCookieStores } from './sessions.ts'
import type { FlushReport } from './sessions.ts'
import { asNumber, asPoint, asRecord, asRect, asString, readBoundsUpdates, readInventory, readLayerOrder, readTileId } from './validate.ts'
import { WorkspaceStore, readWindowState } from './workspaces.ts'
import { BookmarkFile } from './bookmarks.ts'
import { Clipper, EXTRACTION_SCRIPT, clipDirFor, readClipSource } from './clipper.ts'
import { buildClipMarkdown, clipFileName, clipTitle } from '../shared/clip.ts'
import {
  APP_SLUG,
  DISPLAY_NAME,
  SMOKE_ENV,
  describeAdopt,
  firstEnv,
  migrateLegacyStorage,
  resolveConfigRoot,
  userDataWasNamed,
} from './config-root.ts'
import type { StoragePlan } from './config-root.ts'

/**
 * Electron prefers `productName` ("Waypoint") over `name` ("waypoint") when it derives the profile
 * directory, which would put the Chromium profile in `~/Library/Application Support/Waypoint`.
 * Pinning the path to the slug keeps the documented location, keeps it stable across manifest edits,
 * and makes the migration target below unambiguous. It has to happen before anything opens a
 * profile, which is why it sits at module scope.
 *
 * ...but only when nobody named a profile: `--user-data-dir` outranks this call, and pinning over it
 * sends an isolated run into the real profile. See `userDataWasNamed`.
 */
const APP_DATA_DIR = app.getPath('appData')
const USER_DATA_NAMED = userDataWasNamed(process.argv)
if (!USER_DATA_NAMED) app.setPath('userData', join(APP_DATA_DIR, APP_SLUG))

/**
 * Take over a `canvas-browser` installation's state before anything opens a profile.
 *
 * This runs at module scope, ahead of `requestSingleInstanceLock()` below, because that lock
 * *creates* the Chromium user-data directory — a migration that ran after it would find an empty
 * `waypoint/` already sitting in the way of the profile it was meant to move.
 *
 * `CONFIG_ROOT` is resolved once and handed to every consumer (`WorkspaceStore`, bookmarks,
 * clips), so one process cannot end up half in the old tree and half in the new one.
 */
let storage: StoragePlan
try {
  storage = migrateLegacyStorage({
    appDataDir: APP_DATA_DIR,
    userDataDir: app.getPath('userData'),
  })
} catch (error) {
  console.error('[storage] Electron paths unavailable; no migration:', error)
  storage = {
    configRoot: resolveConfigRoot(),
    config: { status: 'skipped', reason: 'Electron paths unavailable' },
    profile: { status: 'skipped', reason: 'Electron paths unavailable' },
  }
}
for (const [label, result] of [
  ['config', storage.config],
  ['profile', storage.profile],
] as const) {
  const line = describeAdopt(label, result)
  if (line !== null) console.log(line)
}
const CONFIG_ROOT = storage.configRoot

function appRoot(...parts: string[]): string {
  return join(__dirname, ...parts)
}

/**
 * setBounds on a view whose webContents is gone aborts the process (SIGTRAP),
 * it does not throw, so every layout path goes through this guard.
 */
function setViewBounds(view: WebContentsView, bounds: Rect): void {
  if (view.webContents.isDestroyed()) return
  try {
    view.setBounds(bounds)
  } catch (error) {
    console.error('[layout] setBounds failed:', error)
  }
}

/**
 * Never let a throw turn into Electron's modal error dialog: that dialog spins a
 * nested NSAlert run loop, and work dispatched from inside it is what trapped the
 * process on 2026-11-01 (Electron-2026-11-01-130419.ips: EXC_BREAKPOINT, main
 * thread, `-[NSAlert runModal]` -> CFRunLoop -> Electron Framework). A broken
 * tile or a late view call must cost a log line, not the whole shell.
 */
process.on('uncaughtException', (error) => {
  console.error('[main] uncaught exception:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})

/**
 * Chromium's own logging writes to stderr from native code, so no JavaScript
 * filter can reach it. macOS 27 rejects Chromium's `task_policy_set` calls and
 * Chromium logs each rejection at ERROR — 14 lines across four tiles, growing
 * with every renderer, all noise. `--disable-logging` drops exactly that class
 * and leaves Node/Electron's own output alone (measured: policy 14 → 0, our
 * `[sessions]` line intact). The cost is Chromium's `[ERROR:…]` diagnostics; the
 * crash evidence that matters is the `.ips` report, not stderr. Advertising and
 * tracker connection failures are *prevented* by the blocker, not hidden here.
 */
app.commandLine.appendSwitch('disable-logging')

/**
 * Electron prints a Node warning for every navigation it was told to cancel:
 * `electron: Failed to load URL: <url> with error: ERR_BLOCKED_BY_CLIENT`. That
 * is our own ad/tracker block reporting itself — one line per blocked ad frame,
 * eight lines on a tabloid front page. Node's default warning printer is
 * replaced rather than removed, so a genuine warning (a real connection refused,
 * a max-listener leak) still gets through; only our deliberate cancellations are
 * dropped. Anything else here would be hiding information instead of filtering
 * noise.
 */
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  const message = typeof warning.message === 'string' ? warning.message : ''
  if (message.includes('ERR_BLOCKED_BY_CLIENT')) return
  console.warn(warning.stack ?? `${warning.name}: ${message}`)
})

interface ChromeViewSpec {
  name: 'canvas' | 'overlay' | 'dock' | 'sidebar'
  view: WebContentsView
  file: string
  /** Which slice of the shared chrome page this view renders. */
  region: ChromeRegion
  hash: string | null
}

/** The chrome's own key events: observed, never consumed, never forwarded to a page. */
type KeyInput = { type: string; code: string }

class CanvasApp {
  private readonly window: BaseWindow
  private readonly canvas: WebContentsView
  private readonly overlay: WebContentsView
  private readonly dock: WebContentsView
  private readonly sidebar: WebContentsView
  private readonly registry: TileRegistry
  private readonly adblock: Adblocker
  private readonly cosmetic: CosmeticFilter
  /** The pause list is read from disk once, on the first chrome refresh. */
  private cosmeticLoaded = false
  private readonly store = new WorkspaceStore(CONFIG_ROOT)
  /**
   * Clips go to one directory, derived from the store's config root unless
   * `WAYPOINT_CLIP_DIR` (or its pre-rename name `CANVAS_CLIP_DIR`) names another. Deliberately not
   * inside a notes vault: the app writes what a page says, and a page is not a source anyone audited.
   */
  private readonly clipper = new Clipper(clipDirFor(this.store.root))
  /**
   * Bookmarks live beside the workspaces, under the same config root — derived from
   * the store rather than re-deriving the default path a second time. One file, one
   * in-memory copy, atomic writes (see `main/bookmarks.ts`).
   */
  private readonly bookmarks = new BookmarkFile(this.store.root)

  /**
   * `modal` is the only part of the overlay mode that is not derived: whether
   * pan or compact is showing is decided by the pan state machine, so the two
   * can never disagree about who owns the screen.
   */
  private modal: 'none' | 'workspaces' | 'omnibox' = 'none'
  private hint = ''
  private pendingWorld: Point | null = null
  private status: CanvasStatus = { workspace: 'scratch', zoom: 1, tiles: 0 }

  private sidebarOpen = true
  private sidebarWidth = SIDEBAR_WIDTH
  private sidebarTimer: ReturnType<typeof setInterval> | null = null

  private panMode: PanModeState = initialPanMode()
  /**
   * The theme the active workspace is painted with, as main last coerced it. Main
   * only relays: the canvas owns the workspace, so this is the normalised copy that
   * was broadcast, never an independent source of truth.
   */
  private theme: WorkspaceTheme = resolveTheme(undefined)
  private tool: CanvasTool = 'select'

  private workspaceList: string[] = []
  private inventory: TileSummary[] = []

  private rpcSeq = 0
  private dockFocusSeq = 0
  private readonly rpcPending = new Map<number, (value: unknown) => void>()
  private readonly loaded = { canvas: false, overlay: false, dock: false, sidebar: false }
  private smokeStarted = false
  /**
   * The entries of the last context menu any view built. Recorded for the smoke run, which reads
   * what a real right-click produced instead of trusting that the listener exists.
   */
  private lastContextMenu: ContextMenuEntry[] = []
  /**
   * The built Menu behind `lastContextMenu`. Recorded for the smoke run, which invokes a
   * real item's own click handler — reading the entries proves what was offered, not
   * that the item is wired to anything.
   */
  private lastContextMenuMenu: Menu | null = null
  private quitting = false
  /**
   * The quit's own work — save the active workspace, then flush every cookie store —
   * is finished, so the next `before-quit` may let the process leave. One flag for both
   * steps because they are one quit: a second ⌘Q must wait for the work already in
   * flight rather than start a second save against a canvas that is on its way out.
   */
  private quitSettled = false
  /** True while that work runs, so a second ⌘Q joins it instead of repeating it. */
  private quitSettling = false
  /** Set by the window's `close` handler while it holds the close long enough to save. */
  private closeFlushing = false

  /**
   * Autosave. The canvas reports every change (`CH.canvasDirty`) and main owns the
   * debounce, so there is one timer that a quit can cancel instead of a renderer timer
   * that dies with its document mid-write.
   */
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null
  private autosaveInFlight = false
  /** A change arrived while a save was in flight; write again when it lands. */
  private autosaveQueued = false
  /**
   * Bumped by every explicit save and every workspace apply. A debounced write that was
   * armed against an older canvas is dropped: without it, a dirty signal from the
   * workspace just left could land in the file of the one just opened.
   */
  private canvasEpoch = 0
  /** What the last autosave wrote, so the smoke run can wait on a real one. */
  private lastAutosave: { name: string; tiles: number; at: number } | null = null

  constructor() {
    // The window has to exist at the size the last session had, and that is a
    // synchronous read: `new BaseWindow` cannot await. A remembered rect is only used
    // when it still overlaps a display that is attached — a laptop that was docked into
    // a screen which is now gone would otherwise open the app off-screen, which looks
    // exactly like "the app did not launch".
    const remembered = readWindowState(this.store.root)
    const bounds =
      remembered.bounds !== null && screen.getAllDisplays().some((display) => intersects(remembered.bounds!, display.workArea))
        ? remembered.bounds
        : null

    this.window = new BaseWindow({
      ...(bounds ?? { width: DEFAULT_WINDOW_W, height: DEFAULT_WINDOW_H }),
      minWidth: MIN_WINDOW_W,
      minHeight: MIN_WINDOW_H,
      backgroundColor: CANVAS_BG,
      title: DISPLAY_NAME,
      show: false,
    })

    this.canvas = this.createView(CANVAS_PARTITION, '../preload/canvas.js')
    // The HUD and the modals must paint above every tile view, and child views
    // always paint above their parent's DOM. A dedicated overlay view is the
    // only way to get a real top layer without giving up one view per tile.
    this.overlay = this.createView(OVERLAY_PARTITION, '../preload/overlay.js')
    // The dock and the sidebar are separate views rather than DOM in the
    // overlay: a view-sized rectangle is the only way to limit how many pixels
    // of the canvas a floating panel steals. Bottom of the stack by default,
    // raised above the overlay while the pan interceptor is armed.
    this.dock = this.createView(DOCK_PARTITION, '../preload/overlay.js')
    this.sidebar = this.createView(SIDEBAR_PARTITION, '../preload/overlay.js')

    for (const view of [this.canvas, this.overlay, this.dock, this.sidebar]) {
      const stylable = view as unknown as { setBackgroundColor?: (color: string) => void }
      stylable.setBackgroundColor?.(view === this.canvas ? CANVAS_BG : '#00000000')
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    }

    // Ad and tracker blocking: one instance, wired to every session this app
    // runs on — the four chrome views, the default tile partition, and every
    // container a tile opts into (through the registry hook below). Wiring here
    // as well as per tile means the default partition is covered before the
    // first tile exists.
    this.adblock = Adblocker.fromFile(Adblocker.pathIn(__dirname))
    for (const view of [this.canvas, this.overlay, this.dock, this.sidebar]) {
      this.adblock.install(view.webContents.session)
    }
    this.adblock.install(session.fromPartition(DEFAULT_TILE_PARTITION))
    console.log(
      `[adblock] ${this.adblock.size} hostnames in ${this.adblock.stats().loadMs}ms; ${this.adblock.stats().instances} session(s) wired`,
    )

    // Cosmetic rules are data beside the host list, and they hide containers the
    // cancelled requests leave behind. The pause list is loaded once, on the first
    // refresh, so a toggle that has not reached disk yet cannot be undone by a repaint.
    this.cosmetic = CosmeticFilter.fromFile(CosmeticFilter.pathIn(__dirname))
    const cosmeticStats = this.cosmetic.stats()
    console.log(
      `[cosmetic] ${cosmeticStats.generic} generic + ${cosmeticStats.hosts} host rule set(s); ${cosmeticStats.paused} paused`,
    )

    this.registry = new TileRegistry(this.window, {
      onRuntime: (runtime) => this.send(this.canvas, CH.tileRuntime, runtime),
      onOpenRequest: (url, partition) => this.send(this.canvas, CH.tileOpenRequest, { url, partition }),
      onStackChanged: () => this.restack(),
      cosmeticCss: (url) => this.cosmetic.cssFor(url),
      onContextMenu: (params, target, openUrl, partition) => this.showContextMenu(params, target, openUrl, partition),
      onSession: (ses) => {
        this.adblock.install(ses)
      },
      isShuttingDown: () => this.quitting || this.window.isDestroyed(),
    })

    const specs: ChromeViewSpec[] = [
      { name: 'canvas', view: this.canvas, file: '../renderer/index.html', region: 'main', hash: null },
      { name: 'overlay', view: this.overlay, file: '../renderer/overlay.html', region: 'main', hash: 'main' },
      { name: 'dock', view: this.dock, file: '../renderer/overlay.html', region: 'dock', hash: 'dock' },
      { name: 'sidebar', view: this.sidebar, file: '../renderer/overlay.html', region: 'sidebar', hash: 'sidebar' },
    ]

    // A renderer that dies must not take the shell with it: log the reason and
    // rebuild that view's UI instead of leaving a blank or wedged window.
    for (const spec of specs) {
      spec.view.webContents.on('render-process-gone', (_event, details) => {
        const exitCode = details.exitCode
        const suffix = exitCode === undefined ? '' : ` (exit ${exitCode})`
        // Teardown kills renderers: not a crash, do not report it as one.
        if (this.quitting || this.window.isDestroyed()) return
        console.error(`[${spec.name}] renderer gone: ${details.reason}${suffix}`)
        if (this.smokeStarted) return
        if (spec.view.webContents.isDestroyed()) return
        // The canvas renderer owns the world model, so its tile views are
        // orphaned once it restarts; drop them rather than let the two diverge.
        if (spec.name === 'canvas') this.registry.clear()
        this.load(spec)
      })
      spec.view.webContents.on('before-input-event', (_event, input) => {
        this.handleKeyInput({ type: input.type, code: input.code })
      })
      // The app's own fields get the same menu a page does, so "right-click, Paste" and ⌘V are
      // one model rather than two: the omnibox, the workspace name, the container name and the
      // theme's hex field are all inputs in these four views.
      spec.view.webContents.on('context-menu', (_event, params: ContextMenuParams) => {
        this.showContextMenu(params, spec.view.webContents)
      })
    }

    this.window.contentView.addChildView(this.canvas)
    this.window.contentView.addChildView(this.overlay)
    this.window.contentView.addChildView(this.dock)
    this.window.contentView.addChildView(this.sidebar)

    this.wireIpc()
    this.layout()

    // Read the bookmark file once, before anything can ask about it: the star's first
    // press and a context menu's label both want the answer without waiting, and a
    // file read on a gesture would be a menu that opens a frame late.
    void this.bookmarks.load().then(() => {
      console.log(`[bookmarks] ${this.bookmarks.count()} record(s) in ${this.bookmarks.path}`)
      this.publishBookmarks()
    })

    this.window.on('resize', () => this.layout())
    /**
     * Closing the window is the ordinary way to quit here — `window-all-closed` quits
     * the app — and by the time that fires the child views are gone, so there is
     * nothing left to collect. Hold the close once, save, then let it through. The
     * guard on `quitSettled` is what keeps a ⌘Q (which has already saved) from being
     * held twice.
     */
    this.window.on('close', (event) => {
      if (this.quitSettled || this.closeFlushing) return
      event.preventDefault()
      this.closeFlushing = true
      void this.flushBeforeClose()
    })
    this.window.on('closed', () => {
      this.quitting = true
      this.stopSidebarAnimation()
      // Bookkeeping only: the shell already destroyed its child views.
      this.registry.clear()
    })
    /**
     * Chromium writes the cookie store on its own schedule, not when the last
     * window closes, so a quit straight after a login can lose it. The canvas is still
     * alive at this point (the quit is prevented), which is also the only moment a
     * pending move can be collected — so the same gate saves the workspace first, then
     * flushes. Only for one bounded budget, then quit regardless.
     *
     * An `async` listener would be ignored by Electron (it does not await the returned
     * promise), which is why this is preventDefault plus a second `app.quit()` rather
     * than an `await` inside the handler.
     */
    app.on('before-quit', (event) => {
      this.quitting = true
      this.stopSidebarAnimation()
      if (this.quitSettled) return
      event.preventDefault()
      if (this.quitSettling) return
      this.quitSettling = true
      void this.settleThenQuit()
    })

    for (const spec of specs) this.load(spec, true)

    // Maximize unless the last session says the window was a sized one: remembering
    // geometry that is immediately thrown away would be worse than not remembering it.
    if (bounds === null || remembered.maximized) this.window.maximize()
    this.window.show()
  }

  private createView(partition: string, preload: string): WebContentsView {
    return new WebContentsView({
      webPreferences: {
        preload: appRoot(preload),
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })
  }

  private load(spec: ChromeViewSpec, announce = false): void {
    const options = spec.hash === null ? {} : { hash: spec.hash }
    void spec.view.webContents.loadFile(appRoot(spec.file), options).catch((error: unknown) => {
      console.error(`[${spec.name}] failed to load UI:`, error)
    })
    if (!announce) return
    spec.view.webContents.once('did-finish-load', () => {
      this.loaded[spec.name] = true
      void this.maybeRunSmoke()
    })
  }

  // ---------------------------------------------------------------- layout

  private layout(): void {
    // resize and layout can land after the window is already gone.
    if (this.window.isDestroyed()) return
    const { width, height } = this.window.getContentBounds()
    setViewBounds(this.canvas, { x: 0, y: 0, width, height })
    setViewBounds(this.sidebar, this.sidebarBounds())
    setViewBounds(this.dock, this.dockBounds())
    setViewBounds(this.overlay, this.overlayBounds())
  }

  /** Derived so the pan interceptor and the modal can never both claim the screen. */
  private currentMode(): OverlayMode {
    if (this.panMode.armed) return 'pan'
    if (this.modal === 'omnibox') return 'omnibox'
    if (this.modal === 'workspaces') return 'workspaces'
    return 'compact'
  }

  private contentSize(): { width: number; height: number } {
    if (this.window.isDestroyed()) return { width: 0, height: 0 }
    const { width, height } = this.window.getContentBounds()
    return { width, height }
  }

  overlayBounds(): Rect {
    const { width, height } = this.contentSize()
    if (this.currentMode() === 'compact') {
      const hudWidth = Math.min(HUD_COMPACT_WIDTH, Math.max(200, width - HUD_MARGIN * 2))
      return {
        // Top-right: the sidebar owns the left edge of the same row.
        x: Math.max(HUD_MARGIN, width - hudWidth - HUD_MARGIN),
        y: HUD_MARGIN,
        width: hudWidth,
        height: HUD_COMPACT_HEIGHT,
      }
    }
    // Modals and the pan interceptor both need the whole window.
    return { x: 0, y: 0, width, height }
  }

  sidebarBounds(): Rect {
    const { width, height } = this.contentSize()
    if (!this.sidebarOpen && this.sidebarWidth <= SIDEBAR_RAIL_WIDTH) {
      return { x: 0, y: 0, width: SIDEBAR_RAIL_WIDTH, height: SIDEBAR_RAIL_WIDTH }
    }
    return { x: 0, y: 0, width: Math.min(this.sidebarWidth, Math.max(SIDEBAR_RAIL_WIDTH, width - 240)), height }
  }

  dockBounds(): Rect {
    const { width, height } = this.contentSize()
    const left = Math.max(0, this.sidebarWidth) + DOCK_MARGIN
    const available = Math.max(1, width - left - DOCK_MARGIN)
    const dockWidth = Math.min(DOCK_WIDTH, available)
    const dockHeight = Math.min(DOCK_HEIGHT, Math.max(1, height - DOCK_BOTTOM - DOCK_MARGIN))
    return {
      // Centred in the space the sidebar leaves, never on top of it.
      x: Math.round(left + (available - dockWidth) / 2),
      y: Math.max(0, height - dockHeight - DOCK_BOTTOM),
      width: Math.round(dockWidth),
      height: Math.round(dockHeight),
    }
  }

  /**
   * Tiles are added at the top of the stack by focus(); the chrome goes back on
   * top of them. While the pan interceptor is armed the overlay drops *below*
   * the dock and sidebar, so those two stay clickable (and the hand tool can be
   * switched off from the pill that switched it on) while everything else is
   * captured by the interceptor.
   */
  private restack(): void {
    if (this.window.isDestroyed()) return
    const container = this.window.contentView
    const order = this.panMode.armed
      ? [this.overlay, this.dock, this.sidebar]
      : [this.dock, this.sidebar, this.overlay]
    for (const view of order) {
      try {
        container.removeChildView(view)
      } catch {
        // Not attached yet; addChildView below is still correct.
      }
      try {
        container.addChildView(view)
      } catch (error) {
        console.error('[chrome] could not restack:', error)
      }
    }
  }

  private async setMode(mode: Exclude<OverlayMode, 'pan'>, world: Point | null): Promise<void> {
    if (this.window.isDestroyed()) return
    const modal = mode === 'compact' ? 'none' : mode
    this.pendingWorld = modal === 'none' ? null : world ?? this.pendingWorld
    // Tell the pan machine first: closing a modal may re-arm the interceptor,
    // which decides the mode. Opening one always disarms it.
    this.applyPanEvent({ type: 'modal', open: modal !== 'none' })
    this.modal = modal
    setViewBounds(this.overlay, this.overlayBounds())
    // A modal grows to the full window, so the overlay has to be on top of the
    // dock and the sidebar again — they were raised while the interceptor was armed.
    this.restack()
    await this.refreshChrome()
  }

  private async refreshChrome(): Promise<void> {
    this.workspaceList = await this.store.list()
    // Load the persisted pause list exactly once. Re-reading it on every refresh would
    // race a toggle that has not been written yet and silently re-enable the site.
    if (!this.cosmeticLoaded) {
      this.cosmeticLoaded = true
      const info = await this.store.session()
      this.cosmetic.loadPaused(info.cosmeticPaused)
    }
    this.publishChrome()
  }

  /**
   * The inventory as the chrome sees it: main is the only side that knows the rule
   * set and the pause list, so cosmetic state is derived here, once, for the sidebar
   * and for anything else that reads the inventory. A row therefore cannot offer a
   * toggle for a host with no rules.
   */
  private tilesWithCosmetic(): TileSummary[] {
    return this.inventory.map((tile) => {
      if (!this.cosmetic.hasRules(tile.url)) return tile
      return { ...tile, cosmetic: true, paused: this.cosmetic.isPaused(hostOf(tile.url) ?? '') }
    })
  }

  private chromeConfig(): OverlayConfig {
    return {
      mode: this.currentMode(),
      current: this.status.workspace,
      workspaces: this.workspaceList,
      hint: this.hint,
      zoom: this.status.zoom,
      sidebarOpen: this.sidebarOpen,
      tool: this.tool,
      tiles: this.tilesWithCosmetic(),
      // The shelf and the omnibox suggestions both read this one list, so they cannot
      // disagree about what is saved; any change arrives as a fresh config push.
      bookmarks: this.bookmarks.list(),
    }
  }

  private publishChrome(): void {
    const config = this.chromeConfig()
    for (const view of [this.overlay, this.dock, this.sidebar]) this.send(view, CH.overlayConfig, config)
  }

  /**
   * Tell every view what the bookmark file now holds.
   *
   * Two paths on purpose: the chrome reads the list out of `overlay:config` (that is
   * where its other lists live), and the canvas has no config channel at all, so it
   * gets the array directly. Both are the same array from the same source, pushed in
   * the same call, so they cannot disagree about what is saved.
   */
  private publishBookmarks(): void {
    this.send(this.canvas, CH.bookmarksChanged, this.bookmarks.list())
    this.publishChrome()
  }

  /**
   * Keep or forget one page, and say which happened. The star, the link menu and the
   * shelf's remove button all funnel through here, so the file has one writer and the
   * log has one shape.
   */
  private async toggleBookmark(entry: { url: string; title?: string; container?: string }): Promise<{
    bookmarked: boolean
    error?: string
  }> {
    const result = await this.bookmarks.toggle(entry)
    if (result.ok) {
      // One line either way: a star that changed nothing on disk is unanswerable from
      // the button, and this is the only place that can tell the two apart.
      console.log(`[bookmarks] ${result.bookmarked ? 'saved' : 'removed'} ${entry.url} (${this.bookmarks.count()} kept)`)
      this.publishBookmarks()
      return { bookmarked: result.bookmarked === true }
    }
    console.error(`[bookmarks] ${entry.url} not changed: ${result.error ?? 'unknown'}`)
    return { bookmarked: this.bookmarks.has(entry.url), error: result.error }
  }

  private send(view: WebContentsView, channel: string, payload: unknown): void {
    if (view.webContents.isDestroyed()) return
    view.webContents.send(channel, payload)
  }

  /**
   * Coerce a theme once and hand the same object to every view.
   *
   * The canvas and the chrome are separate documents: neither can inherit a style
   * from the other and neither can see the other's pixels, so the theme travels as
   * data. Coercing here and only here means a malformed value from either end cannot
   * reach the other half of the UI, and the two halves cannot disagree.
   */
  private publishTheme(raw: unknown): void {
    this.theme = resolveTheme(raw)
    for (const view of [this.canvas, this.overlay, this.dock, this.sidebar]) {
      this.send(view, CH.themeChanged, this.theme)
    }
  }

  // --------------------------------------------------------------- menus

  /**
   * One builder and one popup policy for every menu a view can raise.
   *
   * `openUrl` is optional because it is the only part a caller must get right: a tile closes over
   * its own container, so a link opens in the jar the tile lives in. A chrome view passes nothing
   * and gets the default jar, which is where a link typed into the omnibox would land.
   */
  private showContextMenu(
    params: AppMenuParams,
    target: WebContents,
    openUrl?: (url: string) => void,
    partition?: string,
  ): void {
    // The bookmark entry is a toggle, so its label has to be built from the file's
    // current state. `bookmarked` is main's answer, read synchronously from the copy it
    // keeps in memory, never the page's guess about itself.
    const link = typeof params.linkURL === 'string' ? params.linkURL : ''
    // Explicit fields rather than a spread: `ContextMenuParams` here is this app's own
    // subset of Electron's params, and the subset is the whitelist the builder reads.
    const withState: AppMenuParams = link
      ? {
          linkURL: params.linkURL,
          linkText: params.linkText,
          isEditable: params.isEditable,
          selectionText: params.selectionText,
          editFlags: params.editFlags,
          bookmarked: this.bookmarks.has(link),
        }
      : params
    const entries = buildContextMenu(withState)
    if (entries.length === 0) return
    const menu = contextMenu(entries, withState, {
      target,
      openUrl: openUrl ?? ((url) => this.send(this.canvas, CH.tileOpenRequest, { url })),
      // A link right-clicked inside a container tile is filed in that container, the
      // same rule its popups follow; a chrome-view link has no tile and lands in the
      // shared jar, which is where a link typed into the omnibox would open.
      bookmarkUrl: (url, title) => {
        void this.toggleBookmark({ url, title, container: partition })
      },
    })
    this.lastContextMenu = entries
    this.lastContextMenuMenu = menu
    // A native popup during the smoke run would sit over the suite's own clicks; the run asserts
    // the entries a real right-click produced instead of a menu nobody can inspect.
    if (this.smokeStarted) return
    popupMenu(menu, this.window)
  }

  // ------------------------------------------------------------- pan mode

  private applyPanEvent(event: PanModeEvent): void {
    const next = reducePanMode(this.panMode, event)
    if (next === this.panMode) return
    const wasArmed = this.panMode.armed
    this.panMode = next
    if (next.armed === wasArmed) return
    if (this.window.isDestroyed()) return
    // Arming changes the overlay's size *and* its place in the stack.
    setViewBounds(this.overlay, this.overlayBounds())
    this.restack()
    this.publishChrome()
  }

  private handleKeyInput(input: KeyInput): void {
    if (this.quitting || this.window.isDestroyed()) return
    if (input.type !== 'keyDown') return
    // Escape gets you out of a latched hand tool without reaching for the pill.
    if (input.code === 'Escape' && this.tool === 'pan') this.setTool('select')
  }

  private setTool(tool: CanvasTool): void {
    if (this.tool === tool) return
    this.tool = tool
    this.applyPanEvent({ type: 'tool', pan: tool === 'pan' })
    this.publishChrome()
  }

  private focusDock(prefix?: string): void {
    if (this.window.isDestroyed()) return
    this.dockFocusSeq += 1
    // `prefix` is the container picker's half of the gesture: main arms the dock's
    // field with `@name ` so the next keystroke is an address, not a name.
    this.send(this.dock, CH.dockFocus, prefix === undefined ? { seq: this.dockFocusSeq } : { seq: this.dockFocusSeq, prefix })
    if (this.dock.webContents.isDestroyed()) return
    try {
      this.dock.webContents.focus()
    } catch (error) {
      console.error('[dock] focus failed:', error)
    }
  }

  private focusCanvas(): void {
    if (this.window.isDestroyed() || this.canvas.webContents.isDestroyed()) return
    try {
      this.canvas.webContents.focus()
    } catch (error) {
      console.error('[canvas] focus failed:', error)
    }
  }

  // --------------------------------------------------------------- sidebar

  private setSidebarOpen(open: boolean): void {
    if (this.sidebarOpen === open) return
    this.sidebarOpen = open
    this.animateSidebar()
    this.publishChrome()
  }

  private stopSidebarAnimation(): void {
    if (this.sidebarTimer === null) return
    clearInterval(this.sidebarTimer)
    this.sidebarTimer = null
  }

  /**
   * The sidebar's width is a native view bound, so the slide is animated in
   * main rather than in CSS: shrinking the view in one step would leave its
   * transparent margin swallowing clicks for the length of a CSS transition.
   */
  private animateSidebar(): void {
    this.stopSidebarAnimation()
    const target = this.sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_RAIL_WIDTH
    const from = this.sidebarWidth
    if (from === target) {
      this.layout()
      return
    }
    const startedAt = Date.now()
    this.sidebarTimer = setInterval(() => {
      if (this.window.isDestroyed()) {
        this.stopSidebarAnimation()
        return
      }
      const progress = Math.min(1, (Date.now() - startedAt) / SIDEBAR_SLIDE_MS)
      const eased = 1 - (1 - progress) ** 3
      this.sidebarWidth = Math.round(from + (target - from) * eased)
      if (progress >= 1) {
        this.sidebarWidth = target
        this.stopSidebarAnimation()
      }
      this.layout()
    }, 16)
  }

  // ------------------------------------------------------------------- rpc

  /**
   * Main asks the canvas renderer for authoritative state (tiles and viewport)
   * because the renderer owns the world model. Bounded so a wedged renderer
   * cannot hang the HUD forever — and bounded again, shorter, by a caller that is
   * holding a quit open.
   */
  private askCanvas(op: CanvasRpc['op'], payload?: unknown, timeoutMs = 5000): Promise<unknown> {
    const id = ++this.rpcSeq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcPending.delete(id)
        reject(new Error(`canvas did not answer "${op}" within ${timeoutMs}ms`))
      }, timeoutMs)
      this.rpcPending.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      this.send(this.canvas, CH.canvasRpc, { id, op, payload } satisfies CanvasRpc)
    })
  }

  private resolveRpc(payload: unknown): void {
    const record = asRecord(payload)
    const id = asNumber(record?.id)
    if (id === null) return
    const resolve = this.rpcPending.get(id)
    if (!resolve) return
    this.rpcPending.delete(id)
    resolve(record?.value)
  }

  // ------------------------------------------------------------------- ipc

  private fromCanvas(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const sender = this.canvas.webContents
    return !sender.isDestroyed() && event.sender === sender
  }

  /**
   * Overlay, dock and sidebar all run the same page and preload; anything they
   * ask for is app-owned chrome, so they share one trust check.
   */
  private fromChrome(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    for (const view of [this.overlay, this.dock, this.sidebar]) {
      if (view.webContents.isDestroyed()) continue
      if (event.sender === view.webContents) return true
    }
    return false
  }

  private wireIpc(): void {
    ipcMain.on(CH.tileCreate, (event, payload) => {
      if (!this.fromCanvas(event)) return
      const record = asRecord(payload)
      const id = asString(record?.id)
      const url = asString(record?.url)
      const bounds = asRect(record?.bounds)
      if (!id || !url || !bounds) return
      // Optional container. Missing → the shared default jar; invalid → the
      // registry normalises it back to the default rather than trusting it.
      const partition = asString(record?.partition)
      this.registry.create(id, url, bounds, asNumber(record?.zoom) ?? 1, partition ?? undefined, record?.dark === true)
    })

    ipcMain.on(CH.tileUpdateBounds, (event, payload) => {
      if (!this.fromCanvas(event)) return
      this.registry.setBounds(readBoundsUpdates(payload))
    })

    ipcMain.on(CH.tileDestroy, (event, payload) => {
      if (!this.fromCanvas(event)) return
      const id = asString(asRecord(payload)?.id)
      if (id) this.registry.destroy(id)
    })

    ipcMain.on(CH.tileCommand, (event, payload) => {
      if (!this.fromCanvas(event)) return
      const record = asRecord(payload)
      const id = asString(record?.id)
      const command = asString(record?.command)
      if (!id || !command) return
      const allowed: TileCommand[] = ['back', 'forward', 'reload', 'stop']
      if (!allowed.includes(command as TileCommand)) return
      this.registry.command(id, command as TileCommand)
    })

    ipcMain.on(CH.tileFocus, (event, payload) => {
      if (!this.fromCanvas(event)) return
      const id = asString(asRecord(payload)?.id)
      if (id) this.registry.focus(id)
    })

    /**
     * A whole painting order, back to front, proposed by the canvas. Main only
     * re-adds views in the sequence it is given; it never derives an order of its
     * own, because the z-index it can see lives in the canvas DOM.
     */
    ipcMain.on(CH.tileStack, (event, payload) => {
      if (!this.fromCanvas(event)) return
      this.registry.applyStack(readLayerOrder(payload))
    })

    /**
     * Dark mode is main's to answer, not the canvas's to assume: `insertCSS` belongs to a
     * live document, so the reply carries the state the tile actually reached. A crashed
     * page reports its real state with an error instead of a flag that paints nothing.
     */
    ipcMain.handle(CH.tileDark, async (event, payload): Promise<{ on: boolean; error?: string }> => {
      if (!this.fromCanvas(event)) return { on: false, error: 'untrusted sender' }
      const id = readTileId(payload)
      if (!id) return { on: false, error: 'invalid tile id' }
      return this.registry.setDark(id, asRecord(payload)?.on === true)
    })

    /**
     * The clip: main pulls the page's own text with a script that only reads, validates
     * what came back, and writes the note itself. The canvas never sees the content and
     * never names a path.
     */
    ipcMain.handle(CH.tileClip, async (event, payload): Promise<{ ok: boolean; path?: string; error?: string }> => {
      if (!this.fromCanvas(event)) return { ok: false, error: 'untrusted sender' }
      const id = readTileId(payload)
      if (!id) return { ok: false, error: 'invalid tile id' }
      const contents = this.registry.contentsOf(id)
      if (!contents) {
        // Two different refusals: a tile that no longer exists, and one whose renderer
        // crashed. Both are honest, and they are not the same thing to fix.
        return { ok: false, error: this.registry.has(id) ? 'this tile’s page is not running' : 'no such tile' }
      }
      let raw: unknown
      try {
        raw = await contents.executeJavaScript(EXTRACTION_SCRIPT, true)
      } catch (error) {
        return { ok: false, error: `could not read the page: ${String(error)}` }
      }
      const source = readClipSource(raw)
      if (!source) return { ok: false, error: 'the page returned nothing usable' }
      const at = new Date()
      const written = await this.clipper.write(buildClipMarkdown(source, at), clipFileName(source.title, at))
      // One line either way: "did it clip?" cannot be answered by a button that pulsed.
      if (written.ok) console.log(`[clip] ${clipTitle(source.title)} -> ${written.path ?? ''}`)
      else console.error(`[clip] failed: ${written.error ?? 'unknown'}`)
      return written
    })

    ipcMain.on(CH.tileInventory, (event, payload) => {
      if (!this.fromCanvas(event)) return
      this.inventory = readInventory(payload)
      this.publishChrome()
    })

    /**
     * Bookmarks. The canvas names a URL, a title and its container; main owns the file
     * and answers the state it reached, so the star paints the answer rather than the
     * press. Everything about what a bookmark *is* lives in `shared/bookmarks.ts`.
     */
    ipcMain.handle(CH.bookmarkToggle, async (event, payload) => {
      if (!this.fromCanvas(event)) return { bookmarked: false, error: 'untrusted sender' }
      const record = asRecord(payload)
      const url = asString(record?.url)
      if (!url) return { bookmarked: false, error: 'no address to bookmark' }
      return this.toggleBookmark({
        url,
        title: asString(record?.title) ?? '',
        container: asString(record?.container) ?? undefined,
      })
    })

    ipcMain.handle(CH.bookmarkList, async (event) => {
      if (!this.fromCanvas(event)) return []
      // Awaited: the canvas asks at boot, and the answer has to be the file rather
      // than whatever the constructor's read happened to have landed by then.
      await this.bookmarks.load()
      return this.bookmarks.list()
    })

    ipcMain.on(CH.hudRequest, (event, payload) => {
      if (!this.fromCanvas(event)) return
      const record = asRecord(payload)
      const requested = asString(record?.mode)
      const mode: Exclude<OverlayMode, 'pan'> =
        requested === 'omnibox' ? 'omnibox' : requested === 'workspaces' ? 'workspaces' : 'compact'
      void this.setMode(mode, asPoint(record?.world))
    })

    ipcMain.on(CH.dockRequest, (event) => {
      if (!this.fromCanvas(event)) return
      this.focusDock()
    })

    ipcMain.on(CH.chromeToggle, (event) => {
      if (!this.fromCanvas(event)) return
      this.setSidebarOpen(!this.sidebarOpen)
    })

    ipcMain.on(CH.hudStatus, (event, payload) => {
      if (!this.fromCanvas(event)) return
      const record = asRecord(payload)
      this.status = {
        workspace: asString(record?.workspace) ?? this.status.workspace,
        zoom: asNumber(record?.zoom) ?? this.status.zoom,
        tiles: asNumber(record?.tiles) ?? this.status.tiles,
      }
      for (const view of [this.overlay, this.dock, this.sidebar]) {
        this.send(view, CH.overlayStatus, this.status)
      }
    })

    ipcMain.on(CH.panDelta, (event, payload) => {
      if (!this.fromChrome(event)) return
      // Only while armed: a stale drag must not move the canvas after the hand is released.
      if (!this.panMode.armed) return
      const record = asRecord(payload)
      const dx = asNumber(record?.dx)
      const dy = asNumber(record?.dy)
      if (dx === null || dy === null) return
      if (Math.abs(dx) > 4000 || Math.abs(dy) > 4000) return
      this.send(this.canvas, CH.canvasPan, { dx, dy })
    })

    ipcMain.on(CH.canvasRpcReply, (event, payload) => {
      if (!this.fromCanvas(event)) return
      this.resolveRpc(payload)
    })

    /**
     * The canvas reports a change; main owns the timer and the file. No payload: main
     * collects the snapshot itself when the timer expires, which is the same `collect`
     * RPC an explicit save uses, so there is one description of what a workspace is.
     */
    ipcMain.on(CH.canvasDirty, (event) => {
      if (!this.fromCanvas(event)) return
      this.scheduleAutosave()
    })

    ipcMain.handle(CH.workspaceSave, async (event, payload): Promise<ActionResult> => {
      if (!this.fromCanvas(event)) return { ok: false, error: 'untrusted sender' }
      const record = asRecord(payload)
      const name = sanitizeWorkspaceName(asString(record?.name) ?? '')
      const snapshot = this.asSnapshot(record?.state)
      if (!snapshot) return { ok: false, error: 'invalid canvas snapshot' }
      // The snapshot was taken by the renderer before this arrived, so anything already
      // queued is older than what is being written now: drop it rather than let it land
      // on top of this write.
      this.supersedeAutosave()
      const result = await this.store.save(name, snapshot)
      if (result.ok) {
        this.status = { ...this.status, workspace: name }
        await this.store.rememberLast(name)
        await this.refreshChrome()
      }
      return result
    })

    ipcMain.handle(CH.workspaceLoad, async (event, payload) => {
      if (!this.fromCanvas(event)) return null
      const name = asString(asRecord(payload)?.name) ?? ''
      return this.store.load(name)
    })

    ipcMain.handle(CH.sessionGet, async (event) => {
      if (!this.fromCanvas(event)) return { lastWorkspace: null, workspaces: [] }
      return this.store.session()
    })

    ipcMain.handle(CH.overlayAction, async (event, payload): Promise<ActionResult> => {
      if (!this.fromChrome(event)) return { ok: false, error: 'untrusted sender' }
      try {
        return await this.handleOverlayAction(payload)
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    })

    /**
     * The only chrome capability that destroys state, so it gets a fixed channel
     * and its own handler instead of a new `overlay:action` kind: a sender check, a
     * validated partition, and a report either way. The shared jar is refused in
     * `clearContainerStorage()`, where the rule belongs.
     */
    ipcMain.handle(CH.containerClear, async (event, payload): Promise<ActionResult> => {
      if (!this.fromChrome(event)) return { ok: false, error: 'untrusted sender' }
      const partition = asString(asRecord(payload)?.partition)
      if (partition === null) return { ok: false, error: 'no container named' }
      const report = await clearContainerStorage(partition, (name) => session.fromPartition(name))
      // One line either way: "did the clear actually run?" is unanswerable from a
      // click that only changed a menu row.
      if (report.ok) {
        console.log(`[sessions] cleared container ${partition} in ${report.elapsedMs}ms`)
        return { ok: true }
      }
      console.error(`[sessions] container ${partition} not cleared: ${report.error ?? 'unknown'}`)
      return { ok: false, error: report.error }
    })

    /**
     * One theme channel, both directions. The canvas echoes the theme it just applied
     * and the inspector sends what the user moved; main coerces either one and
     * broadcasts the result. Nothing paints a theme it derived for itself, so the two
     * halves of the UI cannot end up disagreeing about what the workspace looks like.
     */
    ipcMain.on(CH.themeUpdate, (event, payload) => {
      if (!this.fromCanvas(event) && !this.fromChrome(event)) return
      this.publishTheme(payload)
    })
  }

  /**
   * The canvas's answer to `collect`: the snapshot plus the workspace it was collected
   * from. The name has to come from the renderer — main's `status.workspace` is a cached
   * copy that lags a switch by one IPC hop, and a debounced write aimed with the stale
   * name lands in the workspace the user just left.
   */
  private asCollected(value: unknown): { snapshot: CanvasSnapshot; workspace: string } | null {
    const record = asRecord(value)
    const snapshot = this.asSnapshot(record)
    if (!snapshot) return null
    return { snapshot, workspace: asString(record?.workspace) ?? '' }
  }

  private asSnapshot(value: unknown): CanvasSnapshot | null {
    const record = asRecord(value)
    if (!record || !Array.isArray(record.tiles)) return null
    const viewport = asRecord(record.viewport)
    const snapshot: CanvasSnapshot = {
      viewport: {
        panX: asNumber(viewport?.panX) ?? 0,
        panY: asNumber(viewport?.panY) ?? 0,
        zoom: asNumber(viewport?.zoom) ?? 1,
      },
      tiles: record.tiles as TileRecord[],
    }
    // Frames are passed through as untrusted data; `WorkspaceStore.save()`
    // coerces them, so nothing here needs to trust the shape.
    if (Array.isArray(record.frames)) snapshot.frames = record.frames as FrameRecord[]
    // The layer order travels like the frames: passed through as untrusted data and
    // coerced by `WorkspaceStore.save()`. It is also the field this whitelist exists
    // to remind you about — omitting it here dropped the theme on every save once,
    // and a missing order would look like the layer list forgetting itself.
    if (Array.isArray(record.stack)) snapshot.stack = record.stack as string[]
    // The theme travels with the snapshot too. Omitting it here dropped it on every
    // save, which looked exactly like the workspace forgetting its colours; the
    // loader still re-coerces, so passing it through is not a trust decision.
    const theme = coerceTheme(record.theme)
    if (theme) snapshot.theme = theme
    return snapshot
  }

  // ---------------------------------------------------------- overlay flow

  private async handleOverlayAction(payload: unknown): Promise<ActionResult> {
    const action = asRecord(payload)
    const kind = asString(action?.kind)

    switch (kind) {
      case 'init': {
        await this.refreshChrome()
        return { ok: true }
      }

      case 'open-workspaces': {
        await this.setMode('workspaces', null)
        return { ok: true }
      }

      case 'collapse': {
        await this.setMode('compact', null)
        return { ok: true }
      }

      case 'switch': {
        const name = asString(action?.name) ?? ''
        const state = await this.store.load(name)
        if (!state) return { ok: false, error: `workspace "${name}" not found` }
        await this.applyToCanvas(state)
        this.status = { workspace: state.name, zoom: state.viewport.zoom, tiles: state.tiles.length }
        await this.store.rememberLast(state.name)
        await this.setMode('compact', null)
        this.focusCanvas()
        return { ok: true }
      }

      case 'save': {
        const name = sanitizeWorkspaceName(asString(action?.name) || this.status.workspace)
        const snapshot = this.asSnapshot(await this.askCanvas('collect'))
        if (!snapshot) return { ok: false, error: 'canvas returned an invalid snapshot' }
        // A pending autosave holds a snapshot of the canvas taken before this request;
        // letting it land afterwards would rewrite what is being saved right now.
        this.supersedeAutosave()
        const result = await this.store.save(name, snapshot)
        if (result.ok) {
          this.status = { ...this.status, workspace: name }
          await this.store.rememberLast(name)
        }
        await this.refreshChrome()
        return result
      }

      case 'new-workspace': {
        // "New" means a real, saved, empty canvas: the switcher lists workspaces
        // that exist on disk, so a new one that only lived in memory would vanish
        // from the list the next time the menu opened. Names are picked here, so
        // the renderer never supplies one it could collide with or traverse with.
        const existing = new Set(await this.store.list())
        let name = 'untitled'
        for (let index = 2; existing.has(name); index += 1) name = `untitled-${index}`
        const empty: CanvasSnapshot = {
          viewport: { panX: 140, panY: 120, zoom: 1 },
          tiles: [],
        }
        await this.applyToCanvas({ version: 1, name, savedAt: new Date().toISOString(), ...empty })
        const written = await this.store.save(name, empty)
        if (!written.ok) return written
        await this.store.rememberLast(name)
        this.status = { workspace: name, zoom: 1, tiles: 0 }
        await this.setMode('compact', null)
        this.focusCanvas()
        return { ok: true, name }
      }

      case 'rename-workspace': {
        const from = asString(action?.name) || this.status.workspace
        const to = asString(action?.next) ?? ''
        const result = await this.store.rename(from, to)
        if (!result.ok) return result
        const next = result.name ?? to
        // Only the file moved: the canvas keeps running. Renaming the workspace
        // you are in re-points the status, so the next ⌘S writes to the new name.
        if (this.status.workspace === from) {
          this.status = { ...this.status, workspace: next }
          await this.store.rememberLast(next)
        }
        await this.refreshChrome()
        return { ok: true, name: next }
      }

      case 'duplicate-workspace': {
        const name = asString(action?.name) || this.status.workspace
        const result = await this.store.duplicate(name)
        if (!result.ok) return result
        const copy = result.name ?? ''
        const state = await this.store.load(copy)
        if (!state) return { ok: false, error: 'the duplicate could not be read back' }
        // A copy nobody switches into is busywork, so the clone becomes current.
        await this.applyToCanvas(state)
        this.status = { workspace: state.name, zoom: state.viewport.zoom, tiles: state.tiles.length }
        await this.store.rememberLast(state.name)
        await this.setMode('compact', null)
        this.focusCanvas()
        return { ok: true, name: copy }
      }

      case 'delete-workspace': {
        const name = asString(action?.name) || this.status.workspace
        if (!(await this.store.exists(name))) return { ok: false, error: `workspace "${name}" not found` }
        const wasActive = this.status.workspace === name
        const remaining = (await this.store.list()).filter((entry) => entry !== name)
        if (remaining.length === 0) {
          // The last workspace is replaced rather than removed outright: an app
          // with no workspace has nowhere to put the next tile, so it falls back
          // to an empty `scratch` exactly as the spec describes.
          await this.store.remove(name)
          const fresh = 'scratch'
          const empty: CanvasSnapshot = { viewport: { panX: 140, panY: 120, zoom: 1 }, tiles: [] }
          const written = await this.store.save(fresh, empty)
          if (!written.ok) return written
          await this.applyToCanvas({ version: 1, name: fresh, savedAt: new Date().toISOString(), ...empty })
          this.status = { workspace: fresh, zoom: 1, tiles: 0 }
          await this.store.rememberLast(fresh)
        } else if (wasActive) {
          const target = remaining[0] ?? name
          const state = await this.store.load(target)
          if (!state) return { ok: false, error: `workspace "${target}" could not be loaded` }
          await this.store.remove(name)
          await this.applyToCanvas(state)
          this.status = { workspace: state.name, zoom: state.viewport.zoom, tiles: state.tiles.length }
          await this.store.rememberLast(state.name)
        } else {
          await this.store.remove(name)
        }
        await this.setMode('compact', null)
        this.focusCanvas()
        await this.refreshChrome()
        return { ok: true, name: this.status.workspace }
      }

      case 'create': {
        // The dock (and the HUD's omnibox modal) hand over exactly what was typed.
        // `@work …` / `work:…` selects a container here, before URL normalisation,
        // so the prefix is never mistaken for part of the address.
        const intent = parseOmniboxInput(asString(action?.input) ?? '')
        const url = normalizeUrl(intent.target)
        if (!url) return { ok: false, error: 'nothing to open' }
        const world = this.pendingWorld
        this.hint = ''
        await this.setMode('compact', null)
        // world === null tells the canvas to spawn at the viewport centre, which
        // is what the dock's omnibox asks for.
        await this.askCanvas('createAt', { url, world, partition: intent.partition })
        this.focusCanvas()
        return { ok: true }
      }

      case 'focus-omnibox': {
        // The container picker uses the same entry point: it hands over the prefix
        // (`@work `) so choosing a jar and typing an address is one gesture.
        const raw = action?.prefix
        this.focusDock(raw === undefined ? undefined : asString(raw) ?? '')
        return { ok: true }
      }

      case 'zoom-reset': {
        await this.askCanvas('zoomReset')
        return { ok: true }
      }

      case 'fit-view': {
        await this.askCanvas('fitAll')
        return { ok: true }
      }

      case 'toggle-sidebar': {
        this.setSidebarOpen(!this.sidebarOpen)
        return { ok: true }
      }

      case 'set-tool': {
        this.setTool(asString(action?.tool) === 'pan' ? 'pan' : 'select')
        this.focusCanvas()
        return { ok: true }
      }

      case 'tile-focus': {
        const id = readTileId(action)
        if (!id) return { ok: false, error: 'invalid tile id' }
        // The canvas raises and centres in one RPC. Main does not call
        // `registry.focus()` here: the paint order is the canvas's list, and a view
        // raised behind its back would leave the DOM and the view stack describing
        // different fronts.
        await this.askCanvas('focusTile', { id })
        return { ok: true }
      }

      case 'tile-close': {
        const id = readTileId(action)
        if (!id) return { ok: false, error: 'invalid tile id' }
        await this.askCanvas('closeTile', { id })
        return { ok: true }
      }

      /**
       * Pause or resume cosmetic filtering for one host.
       *
       * The pause is applied before the write and the refresh, because the page in front
       * of the user is the thing being fixed: the stylesheet is re-injected on every
       * open tile so the containers come back immediately, and the list is written
       * afterwards so a failed write leaves the current session honest about what it did.
       */
      case 'toggle-cosmetic': {
        const host = asString(action?.host)?.trim() ?? ''
        if (host.length === 0) return { ok: false, error: 'invalid cosmetic host' }
        const paused = !this.cosmetic.isPaused(host)
        this.cosmetic.setPaused(host, paused)
        this.registry.refreshCosmetic()
        await this.store.persistCosmeticPaused(this.cosmetic.pausedHosts())
        await this.refreshChrome()
        return { ok: true }
      }

      case 'move-tile': {
        const id = readTileId(action)
        if (!id) return { ok: false, error: 'invalid tile id' }
        const requested = asString(action?.partition) ?? ''
        // A move names its destination explicitly, so a malformed name is an error
        // rather than the silent fall back to the shared jar that a new tile gets:
        // the user asked to *leave* the jar they are in, and landing in the default
        // one instead would look like the move had worked.
        if (requested !== DEFAULT_TILE_PARTITION && !isTilePartition(requested)) {
          return { ok: false, error: `"${requested}" is not a container` }
        }
        // The canvas owns the Tile object and the world model, so the move is an
        // RPC: main cannot re-partition a live view, and a view rebuilt behind the
        // canvas's back would have no bounds and no badge.
        const answer = (await this.askCanvas('moveTile', { id, partition: requested })) as
          | { ok?: boolean; error?: string }
          | undefined
        if (answer?.ok !== true) return { ok: false, error: answer?.error ?? 'the canvas did not move the tile' }
        return { ok: true }
      }

      case 'layer-order': {
        const id = readTileId(action)
        if (!id) return { ok: false, error: 'invalid tile id' }
        const to = asString(action?.to)
        // Two named ends, no fallback: "frontish" is not a request, and silently
        // picking one would move a tile the user did not ask to move.
        if (to !== 'front' && to !== 'back') return { ok: false, error: `"${to ?? ''}" is not a layer position` }
        // The order is the canvas's (it is the only side that holds the DOM z-order
        // and the tile model), so this is an RPC like `moveTile`: the canvas applies
        // it and then hands main the view order. Main cannot derive it.
        const answer = (await this.askCanvas('layerOrder', { id, to })) as
          | { ok?: boolean; error?: string }
          | undefined
        if (answer?.ok !== true) {
          return { ok: false, error: answer?.error ?? 'the canvas did not change the layer order' }
        }
        return { ok: true }
      }

      case 'open-bookmark': {
        const id = asString(action?.id) ?? ''
        const bookmark = id ? this.bookmarks.find(id) : null
        // The file is the authority: a row that named a record the store no longer has
        // is a refusal, not a blank tile the user has to explain to themselves.
        if (!bookmark) return { ok: false, error: 'that bookmark is gone' }
        await this.setMode('compact', null)
        // Container affinity: a bookmark captured in a jar reopens in it, the same rule
        // a popup follows. `createAt` normalises the string again on the canvas side.
        await this.askCanvas('createAt', { url: bookmark.url, world: null, partition: bookmark.container })
        this.focusCanvas()
        return { ok: true, name: bookmark.title }
      }

      case 'remove-bookmark': {
        const id = asString(action?.id) ?? ''
        const result = await this.bookmarks.remove(id)
        if (!result.ok) {
          console.error(`[bookmarks] ${id || '(no id)'} not removed: ${result.error ?? 'unknown'}`)
          return { ok: false, error: result.error }
        }
        console.log(`[bookmarks] removed ${id} (${this.bookmarks.count()} kept)`)
        this.publishBookmarks()
        return { ok: true }
      }

      default:
        return { ok: false, error: `unknown overlay action: ${String(kind)}` }
    }
  }

  // -------------------------------------------------------------- sessions

  /**
   * Flush the cookie store of every partition a tile has used, with one bounded
   * budget for the whole set. Injected `session.fromPartition` keeps `sessions.ts`
   * free of the Electron import so its budget and failure paths are unit-tested.
   */
  private flushTileSessions(): Promise<FlushReport> {
    return flushCookieStores(this.registry.partitionsUsed(), (partition) => session.fromPartition(partition))
  }

  private logFlush(report: FlushReport): void {
    // One line on success as well as on failure: without it, "did the quit path
    // actually flush anything?" is unanswerable from the console of a real run.
    const asked = report.flushed.length + report.timedOut.length + report.failed.length
    console.log(
      `[sessions] flushed ${report.flushed.length}/${asked} cookie store(s) in ${report.elapsedMs}ms` +
        (report.failed.length > 0 ? ` failed=${report.failed.join(',')}` : ''),
    )
    if (report.timedOut.length > 0) {
      console.error(
        `[sessions] cookie flush timed out for ${report.timedOut.join(', ')} after ${report.elapsedMs}ms — quitting anyway`,
      )
    }
  }

  /**
   * The `before-quit` half: save the workspace, flush the cookies, then quit. Called
   * only after `preventDefault()`, so the process does not leave before either is on
   * disk. Both steps are bounded and neither may throw: a quit that never completes is
   * a worse failure than a lost write.
   */
  private async settleThenQuit(): Promise<void> {
    try {
      await this.saveActiveWorkspace()
    } catch (error) {
      console.error('[sessions] quit-time save failed:', error)
    }
    await this.rememberWindow()
    try {
      this.logFlush(await this.flushTileSessions())
    } catch (error) {
      // Belt and braces: a throw here would leave the quit prevented forever,
      // which is a worse failure than losing a cookie write.
      console.error('[sessions] cookie flush aborted:', error)
    } finally {
      this.quitSettled = true
      this.quitSettling = false
      app.quit()
    }
  }

  /**
   * The window's `close` half: the ordinary quit on macOS arrives here first, while the
   * canvas is still alive. Cookies are flushed by the `before-quit` that follows on
   * `window-all-closed`, so this only saves and lets the window go.
   */
  private async flushBeforeClose(): Promise<void> {
    try {
      await this.saveActiveWorkspace()
    } catch (error) {
      console.error('[sessions] close-time save failed:', error)
    }
    await this.rememberWindow()
    this.closeFlushing = false
    if (!this.window.isDestroyed()) this.window.destroy()
  }

  /**
   * Collect the canvas and write the active workspace. Shared by both quit paths, so
   * "the window was closed" and "the app was quit" cannot disagree about whether the
   * last move was kept. Quietly does nothing when there is nothing to write — no
   * workspace yet, or a canvas that teardown has already taken.
   */
  private async saveActiveWorkspace(): Promise<void> {
    this.cancelAutosave()
    if (this.canvas.webContents.isDestroyed()) return
    const collected = this.asCollected(await this.askCanvas('collect', undefined, QUIT_COLLECT_BUDGET_MS))
    if (!collected) {
      console.error('[sessions] the canvas returned an invalid snapshot on the way out')
      return
    }
    // The canvas names the workspace it just handed over; `status.workspace` cannot, it is
    // a cached copy that a switch leaves behind for one hop.
    const { snapshot, workspace: name } = collected
    if (!isValidWorkspaceName(name)) return
    const result = await this.store.save(name, snapshot)
    if (!result.ok) {
      console.error(`[sessions] "${name}" not saved on the way out: ${result.error ?? 'unknown'}`)
      return
    }
    await this.store.rememberLast(name)
    this.lastAutosave = { name, tiles: snapshot.tiles.length, at: Date.now() }
    console.log(`[sessions] saved "${name}" (${snapshot.tiles.length} tile(s)) on the way out`)
  }

  /** Remember where the window was. Bookkeeping: never throws, never blocks a close. */
  private async rememberWindow(): Promise<void> {
    if (this.window.isDestroyed()) return
    try {
      // A maximized window reports the screen's own frame, so the flag has to travel
      // with the rect: the next launch must not treat a full-screen frame as the size
      // the user chose.
      await this.store.rememberWindow(this.window.getBounds(), this.window.isMaximized())
    } catch (error) {
      console.error('[sessions] window geometry not remembered:', error)
    }
  }

  // -------------------------------------------------------------- autosave

  /**
   * A change arrived. Restart the quiet timer rather than queue one write per frame: a
   * drag emits a change every frame it moves, and the file only needs the state the
   * canvas came to rest in.
   */
  private scheduleAutosave(): void {
    // A quit is already collecting the canvas; a timer armed now would fire into a
    // half-destroyed window and log a failure nobody can act on.
    if (this.quitting) return
    if (this.autosaveTimer !== null) clearTimeout(this.autosaveTimer)
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null
      void this.autosaveNow()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  /** Drop a pending write. */
  private cancelAutosave(): void {
    if (this.autosaveTimer === null) return
    clearTimeout(this.autosaveTimer)
    this.autosaveTimer = null
  }

  /**
   * An explicit save or a workspace switch supersedes anything queued: the snapshot the
   * timer would collect was taken against the canvas as it was, and the epoch is what
   * makes a write that is already in flight drop instead of landing afterwards.
   */
  private supersedeAutosave(): void {
    this.cancelAutosave()
    this.canvasEpoch += 1
  }

  /** Hand a workspace to the canvas, superseding whatever the previous one had queued. */
  private async applyToCanvas(state: WorkspaceState): Promise<void> {
    this.supersedeAutosave()
    await this.askCanvas('apply', state)
  }

  private async autosaveNow(): Promise<void> {
    if (this.autosaveInFlight) {
      // A write is already talking to the canvas: remember that there was more to do
      // and re-arm when it lands, rather than dropping the newer state.
      this.autosaveQueued = true
      return
    }
    const epoch = this.canvasEpoch
    if (this.canvas.webContents.isDestroyed()) return
    this.autosaveInFlight = true
    try {
      const collected = this.asCollected(await this.askCanvas('collect'))
      if (!collected) {
        console.error('[autosave] the canvas returned an invalid snapshot')
        return
      }
      // A switch landed while the snapshot was in flight: this state belongs to the
      // canvas that is gone, and writing it would overwrite the one just opened.
      if (epoch !== this.canvasEpoch) return
      // The name comes from the canvas, with the snapshot it describes. Before it has
      // reported one there is nowhere to write; `scratch` is a renderer-side name until
      // an explicit save gives it a file.
      const { snapshot, workspace: name } = collected
      if (!isValidWorkspaceName(name)) return
      const result = await this.store.save(name, snapshot)
      if (!result.ok) {
        console.error(`[autosave] "${name}" not saved: ${result.error ?? 'unknown'}`)
        return
      }
      await this.store.rememberLast(name)
      this.lastAutosave = { name, tiles: snapshot.tiles.length, at: Date.now() }
      // One line per write, like every other write path: "did anything get saved?" is
      // otherwise unanswerable, and a gesture that silently stops saving looks exactly
      // like a canvas that works.
      console.log(`[autosave] "${name}" (${snapshot.tiles.length} tile(s))`)
      // The first write for a name that was not on disk puts a new row in the switcher,
      // and no other code path exists to announce it.
      if (!this.workspaceList.includes(name)) await this.refreshChrome()
    } catch (error) {
      // A wedged or dead renderer rejects `collect`. That is a lost save, not a crash.
      console.error('[autosave] failed:', error)
    } finally {
      this.autosaveInFlight = false
      if (this.autosaveQueued) {
        this.autosaveQueued = false
        this.scheduleAutosave()
      }
    }
  }

  // ------------------------------------------------------------------ smoke

  private async maybeRunSmoke(): Promise<void> {
    const requested = firstEnv(process.env, SMOKE_ENV) === '1' || process.argv.includes('--smoke')
    if (!requested) return
    const allLoaded = this.loaded.canvas && this.loaded.overlay && this.loaded.dock && this.loaded.sidebar
    if (!allLoaded) return
    if (this.smokeStarted) return
    this.smokeStarted = true
    const { runSmoke } = await import('./smoke.ts')
    const code = await runSmoke({
      canvas: this.canvas,
      overlay: this.overlay,
      window: this.window,
      dock: this.dock,
      sidebar: this.sidebar,
      registry: this.registry,
      store: this.store,
      mode: () => this.currentMode(),
      overlayBounds: () => this.overlayBounds(),
      dockBounds: () => this.dockBounds(),
      sidebarBounds: () => this.sidebarBounds(),
      status: () => this.status,
      tool: () => this.tool,
      inventory: () => this.inventory,
      /** The same derived view the sidebar draws, so a smoke check tests the real path. */
      chromeTiles: () => this.tilesWithCosmetic(),
      blocker: () => this.adblock.stats(),
      cosmetic: (): CosmeticStats => this.cosmetic.stats(),
      viewOrder: () => this.registry.stackOrder(),
      darkOf: (id: string) => this.registry.darkOf(id),
      clipDir: () => this.clipper.dir,
      /** The entries the last real right-click produced, across every view. */
      contextMenu: () => this.lastContextMenu,
      /** The Menu built from those entries, so a check can invoke a real item. */
      contextMenuMenu: () => this.lastContextMenuMenu,
      /** The bookmark file as main holds it, and where it lives. */
      bookmarks: () => this.bookmarks.list(),
      bookmarkPath: () => this.bookmarks.path,
      /** The last workspace main wrote on its own — the debounced autosave. */
      lastAutosave: () => this.lastAutosave,
      /**
       * Run the save the quit and close paths run. A smoke run cannot quit and keep
       * checking, so this is how the quit-time flush is exercised instead of assumed.
       */
      flushActive: () => this.saveActiveWorkspace(),
      /** The same geometry write a close or quit performs, so it can be read back. */
      rememberWindow: () => this.rememberWindow(),
    })
    this.quitting = true
    // Run the same flush the quit path runs: a store that would hang a real ⌘Q
    // then shows up as a stalled smoke run instead of a mysterious freeze.
    this.logFlush(await this.flushTileSessions())
    app.exit(code)
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.setName(DISPLAY_NAME)
  app.on('window-all-closed', () => {
    app.quit()
  })
  app.whenReady().then(() => {
    // Before the shell: a menu has to exist before a document can be asked to copy anything, and
    // this app's window is a BaseWindow, so the Edit items are custom (see src/main/menu.ts).
    setupApplicationMenu()
    const instance = new CanvasApp()
    // Keep the instance reachable for the lifetime of the app.
    void instance
  })
}
