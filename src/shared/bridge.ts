import type { WorkspaceTheme } from './theme.ts'
import type { BookmarkRecord } from './bookmarks.ts'
import type {
  ActionResult,
  CanvasRpc,
  CanvasSnapshot,
  CanvasStatus,
  ChromeRegion,
  OverlayAction,
  OverlayConfig,
  OverlayMode,
  Point,
  Rect,
  SessionInfo,
  TileBoundsUpdate,
  TileCommand,
  TileRuntime,
  TileSummary,
  WorkspaceState,
} from './types.ts'

export interface CanvasBridge {
  readonly platform: string

  createTile(request: { id: string; url: string; bounds: Rect; zoom: number; partition?: string; dark?: boolean }): void
  updateBounds(updates: TileBoundsUpdate[]): void
  destroyTile(id: string): void
  command(id: string, command: TileCommand): void
  focusTile(id: string): void
  /**
   * Apply a painting order to the tile views, back to front. A whole list rather
   * than a per-tile raise because a view stack can only be permuted by re-adding
   * views in sequence — there is no z-index for a child view.
   */
  stackTiles(ids: string[]): void
  /**
   * Insert or remove this tile's dark stylesheet. Answers the state main actually
   * reached: `insertCSS` belongs to a live document, so a crashed or closed page cannot
   * take one, and an optimistic flag in the canvas would be a control that paints
   * nothing.
   */
  setTileDark(id: string, on: boolean): Promise<{ on: boolean; error?: string }>
  /**
   * Extract the tile's page into markdown and file it. The page text never comes back
   * through this bridge — it is pulled by main and written there, so a clipped page
   * cannot hand the canvas a file path or a document.
   */
  clipTile(id: string): Promise<{ ok: boolean; path?: string; error?: string }>
  /**
   * Keep this page, or forget it if it is already kept. Main owns the file and
   * answers the state it reached — the star paints that answer, never the press.
   * The container travels with the request because a bookmark captured in a
   * `persist:work` tile should reopen there.
   */
  toggleBookmark(entry: { url: string; title?: string; container?: string }): Promise<{
    bookmarked: boolean
    error?: string
  }>
  /** The list as main holds it, newest first. Read once at boot, then pushed. */
  listBookmarks(): Promise<BookmarkRecord[]>

  saveWorkspace(name: string, snapshot: CanvasSnapshot): Promise<ActionResult>
  loadWorkspace(name: string): Promise<WorkspaceState | null>
  readSession(): Promise<SessionInfo>
  /**
   * Report that the canvas changed, so main can save the active workspace after a
   * quiet moment. Fire-and-forget: main collects the snapshot itself when the
   * debounce expires, and a canvas that is being torn down must not have to await a
   * reply it will never receive.
   */
  markDirty(): void

  requestOverlay(mode: OverlayMode, world?: Point): void
  requestDockFocus(): void
  toggleSidebar(): void
  pushStatus(status: CanvasStatus): void
  pushInventory(tiles: TileSummary[]): void
  replyRpc(id: number, value: unknown): void

  onRuntime(callback: (runtime: TileRuntime) => void): () => void
  onOpenRequest(callback: (url: string, partition?: string) => void): () => void
  onRpc(callback: (message: CanvasRpc) => void): () => void
  onPan(callback: (delta: { dx: number; dy: number }) => void): () => void
  /**
   * The bookmark list after any change, from the star, the link menu or the shelf.
   * The canvas has no `overlay:config` channel, so this is how its star learns what
   * main did to a page it is not the owner of.
   */
  onBookmarks(callback: (bookmarks: BookmarkRecord[]) => void): () => void
  /** Echo the theme this view is about to paint; main rebroadcasts the coerced form. */
  updateTheme(theme: WorkspaceTheme): void
  onTheme(callback: (theme: WorkspaceTheme) => void): () => void
}

/**
 * The same bridge backs all three chrome views; `region` tells a view which
 * slice of the UI it is responsible for rendering.
 */
export interface OverlayBridge {
  readonly platform: string
  readonly region: ChromeRegion
  action(action: OverlayAction): Promise<ActionResult>
  /**
   * Wipe one container's storage. The main process refuses the shared jar, so the
   * chrome never needs a second opinion about which jars are clearable.
   */
  clearContainer(partition: string): Promise<ActionResult>
  sendPanDelta(dx: number, dy: number): void
  onConfig(callback: (config: OverlayConfig) => void): () => void
  onStatus(callback: (status: CanvasStatus) => void): () => void
  /** `prefix` arms the omnibox with `@container ` so a pick becomes one gesture. */
  onDockFocus(callback: (prefix?: string) => void): () => void
  /**
   * The inspector changed something. Fire-and-forget like a pan delta: a slider
   * drag emits one per input event and must not await a reply.
   */
  updateTheme(theme: WorkspaceTheme): void
  onTheme(callback: (theme: WorkspaceTheme) => void): () => void
}
