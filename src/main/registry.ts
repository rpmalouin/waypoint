import { WebContentsView } from 'electron'
import type { BaseWindow, ContextMenuParams, Session, WebContents } from 'electron'
import { TILE_ID_RE } from '../shared/constants.ts'
import { DARK_MODE_CSS } from '../shared/dark-mode.ts'
import { clampZoom, isNavigableUrl } from '../shared/math.ts'
import { normalizeTilePartition } from '../shared/session-partition.ts'
import type { Rect, TileBoundsUpdate, TileCommand, TileRuntime } from '../shared/types.ts'
import { asRect } from './validate.ts'

interface NavHistory {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
}

export interface Entry {
  view: WebContentsView
  zoom: number
  /** The partition this view was built on, kept so callers can inspect the jar. */
  partition: string
  /** Re-run cosmetic injection for the current document (a rule or pause changed). */
  applyCosmetic: () => void
  /**
   * Dark mode for this tile. The flag and the stylesheet key live in one closure inside
   * the registry, so "is it dark" is answered by the side that inserted the sheet rather
   * than by a copy the canvas keeps.
   */
  isDark: () => boolean
  setDark: (on: boolean) => Promise<boolean>
  dispose: () => void
}

export interface RegistryHooks {
  onRuntime: (runtime: TileRuntime) => void
  /**
   * A tile asked for a new window (`window.open`, target=_blank). The partition
   * comes along: a popup from a container tile has to stay in that container, or
   * opening a link would leak the page into the shared jar.
   */
  onOpenRequest: (url: string, partition: string) => void
  /** Called after any z-order change so the caller can re-raise the HUD. */
  onStackChanged: () => void
  /**
   * The cosmetic stylesheet for a URL, or `''` for nothing to inject. Main owns the
   * rules and the pause set; the registry only knows when a document is ready.
   */
  cosmeticCss?: (url: string) => string
  /**
   * A right-click on a tile's page. The registry says which view was hit and which container its
   * links belong in; main builds the menu and owns the popup policy, so there is one builder.
   *
   * `partition` is the tile's own container, passed along because the menu's bookmark
   * entry files the link in the jar the page was opened in — the same rule a popup follows.
   */
  onContextMenu?: (
    params: ContextMenuParams,
    target: WebContents,
    openUrl: (url: string) => void,
    partition: string,
  ) => void
  /**
   * Called with the session a new tile view will run on, before it is attached
   * and before the first navigation. Ad/tracker blocking is installed here so a
   * partition cannot make a request before it is covered.
   */
  onSession?: (session: Session) => void
  /**
   * True once the app is quitting. Renderers are killed during teardown, and
   * reporting that as a crash would put a false failure in front of the user.
   */
  isShuttingDown?: () => boolean
}

function navHistory(webContents: WebContents): NavHistory | null {
  const candidate = (webContents as unknown as { navigationHistory?: NavHistory }).navigationHistory
  return candidate ?? null
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/**
 * Owns `tileId -> WebContentsView`.
 *
 * Every tile is built on a session partition. The default is ONE shared
 * persistent jar (`persist:main`), so a login performed in one tile is already
 * there in the next one, and survives a restart because the partition is
 * `persist:`. A tile may ask for its own partition instead — `persist:work` for
 * a container that must not see the default cookies, or a bare `work` for an
 * in-memory jar that is gone when the app quits — and that string travels with
 * the tile through every workspace save and load.
 *
 * The set of partitions is recorded here and outlives `clear()`, because the
 * quit path has to flush cookie stores after the views are already torn down.
 */
export class TileRegistry {
  private readonly tiles = new Map<string, Entry>()
  /**
   * Every partition a tile has been created on, including ones whose views are
   * long gone. Never cleared: `before-quit` runs after the window has destroyed
   * its child views, and those stores still need flushing.
   */
  private readonly partitionsSeen = new Set<string>()
  /**
   * id -> reason, for tiles whose renderer died. A crashed webContents is NOT
   * `isDestroyed()`, so it passes the obvious guard while every view call on it
   * is unsafe; this map is the second half of the liveness check.
   */
  private readonly dead = new Map<string, string>()

  /**
   * The view order as main last applied it, back to front. Kept so a proposed order
   * can be completed (a live tile the list forgot is appended rather than dropped)
   * and so the paint order is documented in one place. It is deliberately not what
   * `stackOrder()` reads: that walks the real child list, because a mirror can only
   * agree with reality or be wrong.
   */
  private order: string[] = []

  constructor(
    private readonly window: BaseWindow,
    private readonly hooks: RegistryHooks,
  ) {}

  get size(): number {
    return this.tiles.size
  }

  get ids(): string[] {
    return [...this.tiles.keys()]
  }

  /**
   * Re-run cosmetic injection for every live tile. Called after the rule set or a
   * host's pause changes: the stylesheets are per document, so the only way to take
   * one back off a page that is already open is to re-inject (or inject nothing).
   */
  refreshCosmetic(): void {
    for (const entry of this.tiles.values()) {
      if (entry.view.webContents.isDestroyed()) continue
      entry.applyCosmetic()
    }
  }

  /** True when the entry's webContents can take view calls (bounds, zoom). */
  private usable(id: string, entry: Entry): boolean {
    if (this.dead.has(id)) return false
    return !entry.view.webContents.isDestroyed()
  }

  /** True when the webContents object still exists; a crashed one can be reloaded. */
  private live(entry: Entry): boolean {
    return !entry.view.webContents.isDestroyed()
  }

  create(id: string, url: string, bounds: Rect, zoom: number, partition?: string, initialDark = false): boolean {
    if (!TILE_ID_RE.test(id) || !isNavigableUrl(url)) return false
    // Creating a view while the shell is tearing down attaches it to a window
    // that is already going away — that is a CHECK, not an exception.
    if (this.window.isDestroyed()) return false
    const rect = asRect(bounds)
    if (!rect) return false
    if (this.tiles.has(id)) this.destroy(id)

    // Untrusted like every other renderer string: an invalid or missing
    // partition falls back to the shared jar instead of inventing a storage dir.
    const partitionName = normalizeTilePartition(partition)
    this.partitionsSeen.add(partitionName)

    const view = new WebContentsView({
      webPreferences: {
        // Shared by default (`persist:main`); a tile that asks for its own
        // container gets exactly the string it saved.
        partition: partitionName,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
        // Tiles are all on screen at once; throttling off-screen ones would
        // freeze their rendering while the canvas pans.
        backgroundThrottling: false,
        navigateOnDragDrop: false,
      },
    })
    const webContents = view.webContents
    const emit = (extra: Partial<TileRuntime> = {}): void => this.emit(id, extra)

    // Before any navigation, and before the view joins the tree: this is the
    // only point where we know the session the tile will actually use, and an
    // opt-in container gets its own, so it needs its own wiring.
    this.hooks.onSession?.(webContents.session)

    // Remote content gets no device access by default.
    webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    webContents.session.setPermissionCheckHandler(() => false)

    view.setBounds(rect)
    const initialZoom = clampZoom(zoom)
    webContents.setZoomFactor(initialZoom)
    const stylable = view as unknown as { setBackgroundColor?: (color: string) => void }
    stylable.setBackgroundColor?.('#101010')

    webContents.setWindowOpenHandler(({ url: target }) => {
      // Chromium calls this from inside its own window-open path. Creating a
      // view or dispatching IPC synchronously re-enters the view tree mid
      // navigation and can trip a CHECK (SIGTRAP), so deny now and dispatch on
      // the next tick, when the handler's stack has unwound.
      setImmediate(() => {
        if (webContents.isDestroyed()) return
        if (!target || target === 'about:blank' || !isNavigableUrl(target)) {
          // window.open() with no URL, or a scheme we do not load: nothing to
          // open, but say so instead of leaving an empty tile behind.
          emit({ loading: false, error: `blocked popup: ${target || 'about:blank'}` })
          return
        }
        this.hooks.onOpenRequest(target, partitionName)
      })
      return { action: 'deny' }
    })

    /**
     * Guest pages get no native menu unless main asks for one, so this listener is the only reason
     * a right-click inside a tile does anything at all. It reports the tile's own webContents
     * rather than letting the menu act on whatever holds keyboard focus: a right-click can land on
     * a view that never took focus, and the edit commands would then hit the wrong document.
     */
    const onContextMenu = (_event: unknown, params: ContextMenuParams): void => {
      this.hooks.onContextMenu?.(params, webContents, (url) => this.hooks.onOpenRequest(url, partitionName), partitionName)
    }
    webContents.on('context-menu', onContextMenu)

    const onStartLoading = (): void => {
      // A reload after a crash restarts the renderer: the tile is usable again.
      this.dead.delete(id)
      emit({ loading: true, error: null })
    }
    const onStopLoading = (): void => emit({ loading: false })
    const onNavigate = (): void => emit({ loading: webContents.isLoading() })
    const onTitle = (): void => emit()
    const onFailLoad = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
    ): void => {
      if (errorCode === -3) return // ERR_ABORTED: superseded navigation, not a failure.
      emit({ loading: false, error: `${errorDescription} (${errorCode}) ${validatedUrl}` })
    }
    const onGone = (
      _event: unknown,
      details: { reason?: string; exitCode?: number },
    ): void => {
      const reason = details?.reason ?? 'unknown'
      const exitCode = details?.exitCode
      // Process teardown kills renderers; that is not a tile failure.
      if (this.hooks.isShuttingDown?.()) return
      // A tile that was closed on purpose is gone from the map before its
      // renderer is torn down; reporting that as a crash would be a false alarm.
      if (!this.tiles.has(id)) return
      const suffix = exitCode === undefined ? '' : ` (exit ${exitCode})`
      // Log the real reason — crashed / oom / killed / launch-failed — instead of
      // a generic string, so a repeat is diagnosable from the console alone.
      console.error(`[tile ${id}] renderer gone: ${reason}${suffix}`)
      this.dead.set(id, reason)
      emit({
        loading: false,
        error: `renderer ${reason}${suffix} — press reload to restart it`,
      })
    }

    webContents.on('did-start-loading', onStartLoading)
    webContents.on('did-stop-loading', onStopLoading)
    webContents.on('did-navigate', onNavigate)
    webContents.on('did-navigate-in-page', onNavigate)
    webContents.on('page-title-updated', onTitle)
    webContents.on('did-fail-load', onFailLoad)
    webContents.on('render-process-gone', onGone)

    /**
     * Cosmetic filtering is per *document*: `insertCSS` applies to the page it was
     * called on, so every load and every navigation needs its own injection, and the
     * key from the previous document is dropped rather than reused.
     *
     * `dom-ready` rather than `did-finish-load`: the stylesheet should exist before
     * images settle, or the page lays out around the ad containers and then jumps.
     */
    let cosmeticKey: string | null = null
    const applyCosmetic = (): void => {
      const css = this.hooks.cosmeticCss?.(webContents.getURL()) ?? ''
      const previous = cosmeticKey
      cosmeticKey = null
      if (previous !== null) {
        // The previous document is gone; its key can no longer be removed from the
        // page that owns it, so a rejection here is expected and uninteresting.
        void Promise.resolve(webContents.removeInsertedCSS(previous)).catch(() => {})
      }
      if (css.length === 0) return
      void Promise.resolve(webContents.insertCSS(css))
        .then((key) => {
          cosmeticKey = typeof key === 'string' ? key : null
        })
        .catch((error: unknown) => console.error(`[tile ${id}] cosmetic CSS refused:`, error))
    }
    webContents.on('dom-ready', applyCosmetic)

    /**
     * Dark mode is the same kind of injection as the cosmetic filter, and for the same
     * reason: `insertCSS` belongs to one document, so every load needs its own key and
     * the previous one is dropped rather than reused. `dom-ready`, not
     * `did-finish-load`, so the page does not settle light and then flip.
     *
     * The flag (`dark`) and the key (`darkKey`) are one closure pair. `isDark()` answers
     * from them, which is what lets the canvas store what actually happened instead of
     * what it asked for: a refused insert never sets `dark`.
     */
    let darkKey: string | null = null
    let dark = initialDark

    const removeDark = (): void => {
      const previous = darkKey
      darkKey = null
      if (previous === null) return
      // Remove is best-effort: the document that owned the key may already be gone, and a
      // rejection there is expected rather than a failure worth reporting.
      void Promise.resolve(webContents.removeInsertedCSS(previous)).catch(() => {})
    }

    const insertDark = async (): Promise<void> => {
      const key = await webContents.insertCSS(DARK_MODE_CSS)
      darkKey = typeof key === 'string' ? key : null
    }

    const applyDark = (): void => {
      removeDark()
      if (!dark) return
      void insertDark().catch((error: unknown) => console.error(`[tile ${id}] dark mode refused:`, error))
    }
    webContents.on('dom-ready', applyDark)

    const setDark = async (on: boolean): Promise<boolean> => {
      if (on === dark) return dark
      if (webContents.isDestroyed()) return dark
      if (on) {
        removeDark()
        await insertDark()
        dark = true
      } else {
        removeDark()
        dark = false
      }
      return dark
    }

    const dispose = (): void => {
      webContents.off('did-start-loading', onStartLoading)
      webContents.off('did-stop-loading', onStopLoading)
      webContents.off('did-navigate', onNavigate)
      webContents.off('did-navigate-in-page', onNavigate)
      webContents.off('page-title-updated', onTitle)
      webContents.off('did-fail-load', onFailLoad)
      webContents.off('render-process-gone', onGone)
      webContents.off('context-menu', onContextMenu)
      webContents.off('dom-ready', applyCosmetic)
      webContents.off('dom-ready', applyDark)
    }

    try {
      this.window.contentView.addChildView(view)
    } catch (error) {
      // The shell went away between the guard above and this call.
      console.error(`[tile ${id}] could not attach view:`, error)
      safe(() => webContents.close(), undefined)
      return false
    }
    this.tiles.set(id, {
      view,
      zoom: initialZoom,
      partition: partitionName,
      applyCosmetic,
      isDark: () => dark,
      setDark,
      dispose,
    })
    // Filtered, not pushed: a rebuild on the same id (`repartitionTile`) has already
    // destroyed the old view, and a leftover copy would give one tile two positions.
    this.order = [...this.order.filter((entry) => entry !== id), id]
    this.dead.delete(id)
    this.hooks.onStackChanged()

    void webContents.loadURL(url).catch((error: unknown) => {
      emit({ loading: false, error: String(error) })
    })
    emit({ loading: true })
    return true
  }

  setBounds(updates: TileBoundsUpdate[]): void {
    if (this.window.isDestroyed()) return
    for (const update of updates) {
      const entry = this.tiles.get(update.id)
      // No entry, destroyed webContents, or a crashed renderer: any view call
      // here reaches a frame host that no longer exists and traps the process.
      if (!entry || !this.usable(update.id, entry)) continue
      const rect = asRect(update.bounds)
      if (!rect) continue
      safe(() => entry.view.setBounds(rect), undefined)
      // A collapsed tile has no content rect at all. A zero-height view still
      // paints a hairline of page over the title bar below it, so hide it
      // outright and bring it back the moment the tile grows again.
      const wantsVisible = rect.height > 0 && rect.width > 0
      safe(() => {
        if (entry.view.getVisible() !== wantsVisible) entry.view.setVisible(wantsVisible)
      }, undefined)
      if (update.zoom === undefined) continue
      const zoom = clampZoom(update.zoom)
      if (Math.abs(entry.zoom - zoom) <= 0.001) continue
      entry.zoom = zoom
      // Keeps page content reflowing with the canvas instead of showing a
      // porthole into a 1:1 page.
      const webContents = entry.view.webContents
      if (webContents.isDestroyed()) continue
      safe(() => webContents.setZoomFactor(zoom), undefined)
    }
  }

  command(id: string, command: TileCommand): void {
    const entry = this.tiles.get(id)
    if (!entry || !this.live(entry)) return
    const webContents = entry.view.webContents
    const history = navHistory(webContents)
    switch (command) {
      case 'back':
        if (history) safe(() => history.goBack(), undefined)
        break
      case 'forward':
        if (history) safe(() => history.goForward(), undefined)
        break
      case 'reload':
        // Works after a crash too: this is what restarts the renderer.
        safe(() => webContents.reload(), undefined)
        break
      case 'stop':
        safe(() => webContents.stop(), undefined)
        break
    }
  }

  /** Raises the tile above its siblings without recreating its webContents. */
  focus(id: string): void {
    const entry = this.tiles.get(id)
    if (!entry) return
    if (!this.live(entry)) {
      // Nothing left to raise; drop the record so the map cannot go stale.
      this.destroy(id)
      return
    }
    if (this.window.isDestroyed()) return
    const container = this.window.contentView
    try {
      container.removeChildView(entry.view)
    } catch {
      // Already detached; addChildView below is still correct.
    }
    try {
      container.addChildView(entry.view)
    } catch (error) {
      console.error(`[tile ${id}] could not raise view:`, error)
      return
    }
    // One rule for the paint order, two entry points: a raise moves the id to the
    // end of the list. `applyStack()` below is the other, and it is what a whole
    // re-order uses.
    this.order = [...this.order.filter((entry) => entry !== id), id]
    this.hooks.onStackChanged()
  }

  /**
   * Apply a painting order to the live views.
   *
   * A child view has no z-index: the only way to permute the view stack is to remove
   * and re-add views in the wanted sequence, which is what `focus()` does for one
   * tile. This is the same operation for a whole list, so it costs one remove/add
   * per view — bounded by `MAX_TILES_PER_WORKSPACE`, and only reached by an explicit
   * layer action, never by a press.
   *
   * Ids that are not live tiles are ignored, and a live tile the list forgot is
   * appended in its current relative order, so a stale or short list can never
   * detach a view. The pass ends with `onStackChanged()` because main owns the chrome
   * above the tiles: a tile view added after `restack()` would paint over the dock,
   * the sidebar and the overlay.
   */
  applyStack(ids: string[]): void {
    if (this.window.isDestroyed()) return
    const wanted: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (!this.tiles.has(id) || seen.has(id)) continue
      seen.add(id)
      wanted.push(id)
    }
    for (const id of this.order) {
      if (!this.tiles.has(id) || seen.has(id)) continue
      seen.add(id)
      wanted.push(id)
    }
    const container = this.window.contentView
    for (const id of wanted) {
      const entry = this.tiles.get(id)
      if (!entry) continue
      try {
        container.removeChildView(entry.view)
      } catch {
        // Already detached; addChildView below is still correct.
      }
      try {
        container.addChildView(entry.view)
      } catch (error) {
        console.error(`[tile ${id}] could not re-order view:`, error)
      }
    }
    this.order = wanted
    this.hooks.onStackChanged()
  }

  /**
   * The tile views in the order the window actually paints them, back to front.
   * Read from the live child list rather than from `order` above: this is the
   * evidence a check should use, and a mirror can only agree with it or be wrong.
   */
  stackOrder(): string[] {
    if (this.window.isDestroyed()) return []
    const byView = new Map<object, string>()
    for (const [id, entry] of this.tiles) byView.set(entry.view, id)
    const order: string[] = []
    for (const child of this.window.contentView.children) {
      const id = byView.get(child)
      if (id) order.push(id)
    }
    return order
  }

  destroy(id: string): void {
    const entry = this.tiles.get(id)
    if (!entry) return
    this.tiles.delete(id)
    this.order = this.order.filter((other) => other !== id)
    this.dead.delete(id)
    safe(() => entry.dispose(), undefined)
    // Touching contentView during window teardown is the other trap: the shell
    // removes its own child views, so removing them here is a double free.
    if (!this.window.isDestroyed()) {
      safe(() => this.window.contentView.removeChildView(entry.view), undefined)
    }
    safe(() => entry.view.webContents.close(), undefined)
    if (!this.window.isDestroyed()) this.hooks.onStackChanged()
  }

  clear(): void {
    if (this.window.isDestroyed()) {
      // The shell is already going away and owns its child views. Drop
      // bookkeeping only: calling into contentView or webContents here is the
      // exact shape of the teardown trap.
      for (const [id, entry] of this.tiles) {
        this.dead.delete(id)
        safe(() => entry.dispose(), undefined)
      }
      this.tiles.clear()
      this.order = []
      return
    }
    for (const id of [...this.tiles.keys()]) this.destroy(id)
  }

  /**
   * Whether the page is currently painted. A collapsed tile shrinks its content
   * rect to nothing, so the view has to be hidden as well or Electron keeps a
   * one-pixel sliver of the page on screen under the title bar.
   */
  visibleOf(id: string): boolean | null {
    const entry = this.tiles.get(id)
    if (!entry || !this.usable(id, entry)) return null
    return safe(() => entry.view.getVisible(), null)
  }

  boundsOf(id: string): Rect | null {
    const entry = this.tiles.get(id)
    if (!entry || !this.usable(id, entry)) return null
    const bounds = safe(() => entry.view.getBounds(), null)
    if (!bounds) return null
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
  }

  /** The partition a live tile was built on; null once the tile is gone. */
  partitionOf(id: string): string | null {
    return this.tiles.get(id)?.partition ?? null
  }

  /**
   * The tile's actual session object — not `session.fromPartition(partition)`,
   * which would be a statement about a name rather than about the jar this view
   * is really using. Two tiles on the shared partition return the same object.
   */
  sessionOf(id: string): Session | null {
    const entry = this.tiles.get(id)
    if (!entry) return null
    return safe(() => entry.view.webContents.session, null)
  }

  /**
   * Insert or remove one tile's dark stylesheet.
   *
   * The answer is the state the document actually reached, not the request: a crashed or
   * closed page cannot take a stylesheet, and a refused insert must not leave the canvas
   * claiming a page is dark when nothing was applied. A dead tile reports the state it
   * is in and an error, because the caller has to draw something truthful.
   */
  async setDark(id: string, on: boolean): Promise<{ on: boolean; error?: string }> {
    const entry = this.tiles.get(id)
    if (!entry) return { on: false, error: 'no such tile' }
    if (!this.usable(id, entry)) {
      return { on: entry.isDark(), error: 'this tile’s page is not running' }
    }
    try {
      return { on: await entry.setDark(on) }
    } catch (error) {
      return { on: entry.isDark(), error: String(error) }
    }
  }

  /** Whether a tile id is still registered, live or crashed. */
  has(id: string): boolean {
    return this.tiles.has(id)
  }

  /** Whether a tile is painted dark right now; null once the tile is gone. */
  darkOf(id: string): boolean | null {
    const entry = this.tiles.get(id)
    if (!entry) return null
    return entry.isDark()
  }

  /**
   * The live webContents for a tile, or null when it is gone or its renderer crashed —
   * the same liveness rule every view call goes through, because `executeJavaScript` on a
   * dead frame host is the trap that aborts the process rather than throwing.
   */
  contentsOf(id: string): WebContents | null {
    const entry = this.tiles.get(id)
    if (!entry || !this.usable(id, entry)) return null
    return entry.view.webContents
  }

  /**
   * Every partition a tile has ever been created on, newest set first. The quit
   * path flushes these stores; it runs after the window has destroyed its child
   * views, which is why this outlives `clear()`.
   */
  partitionsUsed(): string[] {
    return [...this.partitionsSeen]
  }

  private emit(id: string, extra: Partial<TileRuntime> = {}): void {
    const entry = this.tiles.get(id)
    if (!entry) return
    const webContents = entry.view.webContents
    if (webContents.isDestroyed()) return
    const history = navHistory(webContents)
    this.hooks.onRuntime({
      id,
      url: safe(() => webContents.getURL(), ''),
      title: safe(() => webContents.getTitle(), ''),
      canGoBack: history ? safe(() => history.canGoBack(), false) : false,
      canGoForward: history ? safe(() => history.canGoForward(), false) : false,
      loading: safe(() => webContents.isLoading(), false),
      ...extra,
    })
  }
}
