import type { WorkspaceTheme } from './theme.ts'
import type { BookmarkRecord } from './bookmarks.ts'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** screen = (world + pan) * zoom */
export interface Viewport {
  panX: number
  panY: number
  zoom: number
}

export interface TileRecord {
  id: string
  url: string
  title: string
  /**
   * Session container this tile lives in. Absent means the shared default jar
   * (`persist:main`), which is what almost every tile wants. A saved string is
   * preserved verbatim so a tile keeps its own cookies across a workspace save
   * and load — the tile id is not part of the partition name, so it survives
   * anything that regenerates ids.
   */
  partition?: string
  /**
   * Dark mode for this tile: the inverted stylesheet is inserted into the page, and the
   * flag travels with the tile so a reload or a restart puts it back. Absent means off,
   * which is what keeps a workspace nobody darkened byte-identical (same convention as
   * `partition`).
   */
  darkMode?: boolean
  /** World-space position and size (pre-zoom, pre-pan). */
  world: Rect
}

/**
 * A freeform named zone on the canvas. Frames are canvas DOM (they live behind
 * every tile's page view), so they are a spatial annotation rather than a
 * container: dragging one moves the tiles whose centres it holds, nothing else.
 */
export interface FrameRecord {
  id: string
  name: string
  /** World-space top-left, width and height, in the same units as `TileRecord.world`. */
  worldX: number
  worldY: number
  worldW: number
  worldH: number
  /** `#rrggbb` tint for the border and header; absent means the default slate. */
  color?: string
}

export interface WorkspaceState {
  version: 1
  name: string
  savedAt: string
  viewport: Viewport
  tiles: TileRecord[]
  /**
   * Group frames. Absent in every file written before frames existed, and left
   * absent on save while a workspace has none, so those files stay byte-identical.
   */
  frames?: FrameRecord[]
  /**
   * Tile painting order, **back to front**: `stack[0]` is the tile furthest back.
   * Absent means creation order (the order the `tiles` array is in), which is what
   * the canvas did before a layer list existed — so a workspace nobody re-ordered
   * saves without this key at all. Ids not named here have no position by
   * definition, so the loader appends them; see `normalizeLayerOrder()`.
   */
  stack?: string[]
  /**
   * The workspace theme. Absent in every file written before themes existed, and
   * left absent on save while it equals `DEFAULT_THEME`, for the same reason:
   * a workspace that never touched theming keeps its old file shape.
   */
  theme?: WorkspaceTheme
}

export interface CanvasSnapshot {
  viewport: Viewport
  tiles: TileRecord[]
  frames?: FrameRecord[]
  /** Back-to-front tile order; absent when it is still creation order. */
  stack?: string[]
  theme?: WorkspaceTheme
}

export interface TileBoundsUpdate {
  id: string
  bounds: Rect
  zoom?: number
}

export interface TileRuntime {
  id: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  error?: string | null
}

export type TileCommand = 'back' | 'forward' | 'reload' | 'stop'

/**
 * What the sidebar lists. The canvas renderer owns the tile model (it is the
 * only authority on position and title), so it pushes this summary list to main,
 * which fans it out to the dock and sidebar views.
 */
export interface TileSummary {
  id: string
  title: string
  url: string
  selected: boolean
  loading: boolean
  failed: boolean
  /**
   * The tile's container partition, when it is not the shared jar. The sidebar
   * draws the same pill the tile chrome does from this string, so a row can never
   * claim a container the tile is not actually using.
   */
  partition?: string
  /**
   * Cosmetic filtering, as main knows it: whether this tile's host has rules at all,
   * and whether the user has paused them there. The sidebar draws a shield from these
   * and nothing else, so the row cannot offer a control that would do nothing.
   */
  cosmetic?: boolean
  paused?: boolean
  /**
   * Painting order, 0 = furthest back. The canvas owns it and pushes it, the
   * sidebar's layer panel sorts by it (front-to-back, so descending), and the
   * ordinary tile list deliberately ignores it — a raise must not reorder the row
   * list under the pointer.
   */
  layer: number
}

export interface CanvasStatus {
  workspace: string
  zoom: number
  tiles: number
}

export interface SessionInfo {
  lastWorkspace: string | null
  workspaces: string[]
  /** Hosts whose cosmetic rules the user has paused, persisted across launches. */
  cosmeticPaused?: string[]
  /**
   * Window geometry of the last session, in screen points. Absent on a first run
   * and on any file written before geometry was remembered; `coerceWindowBounds()`
   * in `workspaces.ts` is the only reader that decides whether a rect is usable.
   */
  windowBounds?: Rect
  /** Whether that window was maximized. Always written beside `windowBounds`. */
  windowMaximized?: boolean
}

/** `pan` is the transient mode the overlay takes while the interceptor is armed. */
export type OverlayMode = 'compact' | 'workspaces' | 'omnibox' | 'pan'

/** The dock's left pill: select (pointer) or a persistent hand tool. */
export type CanvasTool = 'select' | 'pan'

export type ChromeRegion = 'main' | 'dock' | 'sidebar'

export interface OverlayConfig {
  mode: OverlayMode
  current: string
  workspaces: string[]
  hint: string
  zoom: number
  sidebarOpen: boolean
  tool: CanvasTool
  tiles: TileSummary[]
  /**
   * The bookmarks file as main holds it, newest first. The chrome renders the shelf
   * and the omnibox suggestions from this one list, so the two cannot disagree — and
   * a change anywhere (star, link menu, shelf) arrives here as a fresh config push.
   */
  bookmarks: BookmarkRecord[]
}

export type OverlayAction =
  | { kind: 'init' }
  | { kind: 'open-workspaces' }
  | { kind: 'collapse' }
  | { kind: 'switch'; name: string }
  | { kind: 'save'; name: string }
  /** Start a new, empty workspace and write it out under a fresh name. */
  | { kind: 'new-workspace' }
  /** Rename a workspace file: atomic write under the new name, then unlink. */
  | { kind: 'rename-workspace'; name: string; next: string }
  /** Clone a workspace to `<name>-copy` and switch to the clone. */
  | { kind: 'duplicate-workspace'; name: string }
  /** Unlink a workspace file, never leaving the app without a canvas. */
  | { kind: 'delete-workspace'; name: string }
  | { kind: 'create'; input: string }
  | { kind: 'focus-omnibox'; prefix?: string }
  | { kind: 'zoom-reset' }
  | { kind: 'fit-view' }
  | { kind: 'toggle-sidebar' }
  | { kind: 'set-tool'; tool: CanvasTool }
  | { kind: 'tile-focus'; id: string }
  | { kind: 'tile-close'; id: string }
  /**
   * Pause or resume cosmetic filtering for a host. Per host rather than per tile: the
   * rules apply to the page, and two tiles on the same site should not disagree about
   * whether it is filtered.
   */
  | { kind: 'toggle-cosmetic'; host: string }
  /**
   * Move an open tile into another container. `partition` is the full partition
   * string; the shared jar is `DEFAULT_TILE_PARTITION`, not an empty string, so
   * "no container" is stated rather than implied.
   */
  | { kind: 'move-tile'; id: string; partition: string }
  /**
   * Move an open tile to the front or the back of the canvas. The stacking order
   * itself lives in the canvas renderer, so this is a request it applies and then
   * hands to main as a view order (`CH.tileStack`); main only ever re-adds views in
   * the order it is given.
   */
  | { kind: 'layer-order'; id: string; to: 'front' | 'back' }
  /**
   * Launch a bookmark. Main looks the record up in its own file, so the chrome names
   * a bookmark id rather than a URL and a container it could have made up; a record
   * that has since gone is a refusal, not a blank tile.
   */
  | { kind: 'open-bookmark'; id: string }
  /** Forget one bookmark — the shelf's ✕, the other half of the star. */
  | { kind: 'remove-bookmark'; id: string }

export interface ActionResult {
  ok: boolean
  error?: string
  name?: string
}

export type CanvasRpcOp =
  | 'collect'
  | 'apply'
  | 'createAt'
  | 'focusTile'
  | 'closeTile'
  /** Re-open a tile on another container. The view cannot change jar in place. */
  | 'moveTile'
  /** Raise (to front) or drop (to back) one tile in the canvas's layer list. */
  | 'layerOrder'
  | 'zoomReset'
  | 'fitAll'

export interface CanvasRpc {
  id: number
  op: CanvasRpcOp
  payload?: unknown
}
