import './style.css'
import { buildCssGradient } from '../shared/color.ts'
import { DEFAULT_THEME, resolveTheme } from '../shared/theme.ts'
import type { WorkspaceTheme } from '../shared/theme.ts'
import {
  CAMERA_FIT_MS,
  DEFAULT_TILE_WORLD_H,
  DEFAULT_TILE_WORLD_W,
  FIT_PADDING,
  FRAME_PADDING_WORLD,
  GRID_WORLD_STEP,
  MAX_FRAMES_PER_WORKSPACE,
} from '../shared/constants.ts'
import {
  boundsKey,
  easeCamera,
  fitToView,
  frameRect,
  groupBounds,
  idsInsideFrame,
  layoutTile,
  marqueeHits,
  normalizeUrl,
  padRect,
  panByScreen,
  panTileToCenter,
  placeNewTile,
  resetZoom,
  screenToWorld,
  screenToWorldPoint,
  translateRect,
  tweenViewport,
  worldToScreen,
  zoomAtPoint,
} from '../shared/math.ts'
import type {
  CanvasRpc,
  CanvasSnapshot,
  FrameRecord,
  Point,
  Rect,
  TileBoundsUpdate,
  TileRecord,
  TileSummary,
  Viewport,
  WorkspaceState,
} from '../shared/types.ts'
import { DEFAULT_TILE_PARTITION, normalizeTilePartition } from '../shared/session-partition.ts'
import { moveToEnd, moveToStart, normalizeLayerOrder } from '../shared/layers.ts'
import { bookmarkKey } from '../shared/bookmarks.ts'
import type { BookmarkRecord } from '../shared/bookmarks.ts'
import { Frame, type FrameHooks } from './frames.ts'
import { installInput, type InputApi } from './input.ts'
import { Tile, type TileHooks } from './tiles.ts'

const bridge = window.canvasBridge

const canvasEl = document.getElementById('canvas') as HTMLElement
const gridEl = document.getElementById('grid') as HTMLElement
const framesEl = document.getElementById('frames') as HTMLElement
const tilesEl = document.getElementById('tiles') as HTMLElement
const hintEl = document.getElementById('hint') as HTMLElement

interface CameraMove {
  from: Viewport
  to: Viewport
  start: number
  duration: number
}

interface CanvasState {
  viewport: Viewport
  workspace: string
  tiles: Map<string, Tile>
  frames: Map<string, Frame>
  /**
   * The workspace theme. Held here so a save echoes back what the file carried even
   * while nothing paints it yet — dropping it would make ⌘S a silent reset.
   */
  theme: WorkspaceTheme
  /** Every selected tile, in the order they were added. */
  selected: Set<string>
  /**
   * The tile the last press landed on: the cascade anchor for a new tile, and the
   * one the chrome treats as active. A set alone cannot answer "which was last".
   */
  anchorId: string | null
  /** Last bounds key pushed per tile, so a frame only sends what moved. */
  sent: Map<string, string>
  frame: number
  statusTimer: number
  /** Last inventory JSON pushed to the chrome, to skip redundant IPC. */
  inventoryKey: string
  /** In-flight camera move; the frame pipeline owns the interpolation. */
  camera: CameraMove | null
  /**
   * Tiles the zone being dragged is carrying, with the world rect each had when
   * the press started. Snapshotted once so the set cannot change mid-gesture.
   */
  carry: { ids: string[]; origins: Map<string, Rect> } | null
  /**
   * Origins frozen by a move drag. Every tile in it is placed as
   * `translate(origin, dx, dy)` from the press, never by accumulating deltas, so a
   * dropped or replayed move event cannot drift the group.
   */
  move: Map<string, Rect> | null
  /**
   * Painting order, back to front: `stack[0]` is the tile furthest back. The one
   * authority both layers follow — an inline z-index is derived from the index, and
   * main is handed the same list to re-add its views in. A raise moves the id to the
   * end (see `raiseTile` and `hooks.focus`).
   */
  stack: string[]
  /**
   * Canonical keys (`shared/bookmarks.ts` `bookmarkKey`) of every page main has saved.
   * The star is a lookup against this set, so a tile that navigates can answer "is this
   * page saved?" without asking main — and every tile answers it the same way.
   */
  bookmarkKeys: Set<string>
}

const state: CanvasState = {
  viewport: { panX: 140, panY: 120, zoom: 1 },
  workspace: 'scratch',
  tiles: new Map(),
  frames: new Map(),
  theme: resolveTheme(undefined),
  selected: new Set(),
  anchorId: null,
  sent: new Map(),
  frame: 0,
  statusTimer: 0,
  inventoryKey: '',
  camera: null,
  carry: null,
  move: null,
  stack: [],
  bookmarkKeys: new Set(),
}

/** The visible canvas as a plain size, which is what the camera helpers want. */
function viewSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

// ------------------------------------------------------------ frame pipeline

/**
 * Whether the next painted frame is a *change worth saving*.
 *
 * Every mutation in this file funnels through `schedule()`, which is the one choke
 * point that already decides the canvas has to repaint. Reporting the dirty bit from
 * the frame that does the repainting therefore cannot miss a new mutation the way a
 * per-handler list would — a handler that forgets it is a handler that forgot to
 * paint. It is disarmed while a workspace loads: restoring a canvas is not editing it,
 * and saving on every launch would bump `savedAt` on a file nobody touched.
 */
let autosaveArmed = false

/**
 * Arm the dirty bit one frame after a load, so the paint that puts restored tiles on
 * screen is not mistaken for an edit.
 */
function armAutosave(): void {
  autosaveArmed = false
  requestAnimationFrame(() => {
    autosaveArmed = true
  })
}

/** Report a change to main, unless this view is still settling into a load. */
function reportDirty(): void {
  if (!autosaveArmed) return
  bridge.markDirty()
}

function schedule(): void {
  if (state.frame !== 0) return
  state.frame = requestAnimationFrame(frame)
}

/**
 * The only place tile geometry is computed. One rAF per batch: pan/drag/zoom
 * handlers just mutate state and call schedule(), so IPC is emitted at most
 * once per frame and only for tiles whose bounds actually changed.
 */
function frame(): void {
  state.frame = 0
  advanceCamera()
  const viewport = state.viewport

  document.documentElement.style.setProperty('--zoom', String(viewport.zoom))
  gridEl.style.backgroundSize = `${GRID_WORLD_STEP * viewport.zoom}px ${GRID_WORLD_STEP * viewport.zoom}px`
  gridEl.style.backgroundPosition = `${viewport.panX * viewport.zoom}px ${viewport.panY * viewport.zoom}px`

  const updates: TileBoundsUpdate[] = []
  // Frames first: they paint behind the tiles, and laying them out in the same
  // frame keeps a zone border from trailing the tiles it is supposed to hold.
  for (const zone of state.frames.values()) zone.applyLayout(viewport)
  for (const tile of state.tiles.values()) {
    const layout = layoutTile(tile.world, viewport)
    tile.applyLayout(layout, viewport.zoom)
    const key = boundsKey(layout.content, viewport.zoom)
    if (state.sent.get(tile.id) !== key) {
      state.sent.set(tile.id, key)
      updates.push({ id: tile.id, bounds: layout.content, zoom: viewport.zoom })
    }
  }
  if (updates.length > 0) bridge.updateBounds(updates)

  hintEl.hidden = state.tiles.size > 0
  pushStatus()
  pushInventory()
  // After the pushes, so main has the workspace name this change belongs to before the
  // dirty bit it will debounce: messages from one renderer arrive in order.
  reportDirty()
  if (state.camera !== null) schedule()
}

/**
 * One step of the camera move. Interpolation lives here, in the same frame
 * pipeline as the tile geometry, so a fly-to cannot drift away from the views it
 * moves past: both are computed from the same viewport in the same frame.
 */
function advanceCamera(): void {
  const move = state.camera
  if (move === null) return
  const progress = move.duration <= 0 ? 1 : Math.min(1, (performance.now() - move.start) / move.duration)
  if (progress >= 1) {
    state.viewport = move.to
    state.camera = null
    return
  }
  state.viewport = tweenViewport(move.from, move.to, easeCamera(progress))
}

/** A press or a wheel is the user taking the camera back. */
function cancelCamera(): void {
  state.camera = null
}

function animateCameraTo(target: Viewport | null, duration = CAMERA_FIT_MS): boolean {
  if (!target) return false
  const current = state.viewport
  if (
    target.zoom === current.zoom &&
    Math.abs(target.panX - current.panX) < 0.5 &&
    Math.abs(target.panY - current.panY) < 0.5
  ) {
    state.camera = null
    return true
  }
  state.camera = { from: { ...current }, to: target, start: performance.now(), duration }
  schedule()
  return true
}

function pushStatus(): void {
  if (state.statusTimer !== 0) return
  state.statusTimer = window.setTimeout(() => {
    state.statusTimer = 0
    bridge.pushStatus({
      workspace: state.workspace,
      zoom: Number(state.viewport.zoom.toFixed(2)),
      tiles: state.tiles.size,
    })
  }, 200)
}

/**
 * The sidebar and the dock list tiles, but this renderer owns them: title,
 * selection and loading state all live here, so the summary is built here and
 * main only fans it out. Cheap to recompute, and skipped when nothing changed.
 */
function pushInventory(): void {
  // One map for the whole push rather than an `indexOf` per row: the layer panel
  // sorts by this, and the ordinary tile list ignores it.
  const layers = new Map<string, number>()
  state.stack.forEach((id, index) => layers.set(id, index))
  const tiles: TileSummary[] = [...state.tiles.values()].map((tile) => ({
    id: tile.id,
    title: tile.title,
    url: tile.url,
    selected: state.selected.has(tile.id),
    loading: tile.el.classList.contains('loading'),
    failed: tile.el.classList.contains('failed'),
    // Same normalised value the tile's own badge and view use.
    partition: tile.partition,
    // Back-to-front position; a tile the stack has not learned about yet reads as
    // the bottom, which is where an unstyled element would paint anyway.
    layer: layers.get(tile.id) ?? 0,
  }))
  const key = JSON.stringify(tiles)
  if (key === state.inventoryKey) return
  state.inventoryKey = key
  bridge.pushInventory(tiles)
}

// ---------------------------------------------------------------- bookmarks

/**
 * Adopt the bookmark list main pushed and repaint every star from it.
 *
 * One derivation, here: the canonical keys are built once and no tile keeps its own
 * idea of what is saved. So a page bookmarked from another tile, from the shelf or from
 * a link menu lights the same star, and a navigation that lands somewhere unsaved
 * hollows it again on the next runtime event.
 */
function applyBookmarks(list: BookmarkRecord[]): void {
  const keys = new Set<string>()
  for (const record of Array.isArray(list) ? list : []) {
    const key = bookmarkKey(record.url)
    if (key) keys.add(key)
  }
  state.bookmarkKeys = keys
  for (const tile of state.tiles.values()) tile.setBookmarked(keys.has(bookmarkKey(tile.url)))
}

// ---------------------------------------------------------------- selection

/**
 * The selection is a set, and this function is the only place `.tile-selected` is
 * applied. A shift-click, a marquee hit and a plain click therefore cannot
 * disagree about what is highlighted, and nothing can leave a stale ring behind.
 *
 * Ids that no longer address a tile are dropped on the way in, so a delete mid-
 * marquee cannot put a ghost in the set.
 */
function setSelection(ids: Iterable<string>): void {
  const next = new Set<string>()
  for (const id of ids) if (state.tiles.has(id)) next.add(id)
  let changed = false
  for (const id of state.selected) {
    if (next.has(id)) continue
    state.tiles.get(id)?.setSelected(false)
    changed = true
  }
  for (const id of next) {
    if (state.selected.has(id)) continue
    state.tiles.get(id)?.setSelected(true)
    changed = true
  }
  state.selected = next
  if (changed) pushInventory()
}

function selectOnly(id: string | null): void {
  setSelection(id === null ? [] : [id])
  state.anchorId = id
}

function addToSelection(id: string): void {
  setSelection([...state.selected, id])
  state.anchorId = id
}

function removeFromSelection(id: string): void {
  const next = new Set(state.selected)
  next.delete(id)
  setSelection(next)
  if (state.anchorId === id) state.anchorId = [...next].pop() ?? null
}

function clearSelection(): void {
  setSelection([])
  state.anchorId = null
}

/**
 * The rubberband's hit test, called on every move of a background drag.
 *
 * The box arrives in screen pixels because that is what the pointer produces; the
 * conversion to world happens here, with the same viewport the tiles are laid out
 * from, so a box drawn at 0.25x and the same box at 2x select what they actually
 * cover on screen. `additive` is shift: a shift drag unions with what was already
 * picked instead of replacing it.
 */
function marquee(screenRect: Rect, additive: boolean): void {
  const world = screenToWorld(screenRect, state.viewport)
  const hits = marqueeHits(
    world,
    [...state.tiles.values()].map((tile) => ({ id: tile.id, world: tile.world })),
  )
  setSelection(additive ? [...state.selected, ...hits] : hits)
}

/**
 * True when the press that started the current tile drag found the tile already
 * selected. Release needs it: a shift-click on a tile that was already in the set
 * is the toggle-off half, and a plain click there collapses the selection.
 */
let pressWasSelected = false

// ---------------------------------------------------------------- tile model

function newTileId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  const bytes = new Uint8Array(8)
  cryptoApi.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Paint order among tiles. Re-ordering the DOM was what broke the traffic
 * lights: `append()` runs even when the node is already the last child, so every
 * press on a tile re-parented it, and Chromium — having lost the element it
 * pressed — never synthesised the `click` the buttons listen for. Dragging
 * survived because it uses pointer capture, which follows the node.
 *
 * Raising is therefore expressed as `z-index`, which changes nothing about the
 * node's identity and keeps the topmost tile painting topmost.
 */
let zTop = 0

function raiseTile(tile: Tile): void {
  zTop += 1
  tile.el.style.zIndex = String(zTop)
}

/**
 * A raise, applied to both representations of the order: the inline z-index that
 * decides which chrome paints on top, and the list that main is handed to re-add
 * the views in. One rule — a raise moves the id to the end — so a press and an
 * explicit "bring to front" cannot disagree about what the front is.
 */
function raiseToFront(tile: Tile): void {
  raiseTile(tile)
  state.stack = moveToEnd(state.stack, tile.id)
}

/**
 * Renumber every tile's z-index from the list.
 *
 * `style` only, never the DOM: re-parenting a pressed node ends Chromium's implicit
 * mouse capture, which is what once made the traffic lights unpressable. Renumbering
 * touches no node identity, so a press that lands during it still becomes a click.
 *
 * `zTop` keeps its headroom: a renumber sets the counter to at least the list length,
 * so the next raise (which only increments) still lands above every painted tile.
 */
function paintLayerOrder(): void {
  state.stack.forEach((id, index) => {
    const tile = state.tiles.get(id)
    if (tile) tile.el.style.zIndex = String(index + 1)
  })
  zTop = Math.max(zTop, state.stack.length)
}

/**
 * Move one tile to the front or the back of the canvas.
 *
 * Returns a refusal rather than guessing: an id the canvas does not hold, or a list
 * that came back a different length than it went in (which would mean the model and
 * the tiles had already diverged), leaves everything as it was.
 */
function setLayerOrder(id: string, to: 'front' | 'back'): { ok: boolean; error?: string } {
  const tile = state.tiles.get(id)
  if (!tile) return { ok: false, error: 'no such tile' }
  const next = to === 'front' ? moveToEnd(state.stack, id) : moveToStart(state.stack, id)
  if (next.length !== state.stack.length) {
    return { ok: false, error: 'the layer list does not match the tiles on the canvas' }
  }
  state.stack = next
  paintLayerOrder()
  // Main cannot derive this order (it has no view of the DOM z-index), so the list
  // goes over as data and main only re-adds views in that sequence.
  bridge.stackTiles([...state.stack])
  pushInventory()
  return { ok: true }
}

const hooks: TileHooks = {
  requestFrame: schedule,
  zoom: () => state.viewport.zoom,
  focus: (id, modifiers) => {
    cancelCamera()
    bridge.focusTile(id)
    const tile = state.tiles.get(id)
    if (!tile) return
    // Raising the DOM node mirrors what focus() does to the view: the pressed
    // tile is the topmost one in both layers, and it moves to the end of the list
    // that both layers are derived from.
    raiseToFront(tile)
    pressWasSelected = state.selected.has(id)
    if (modifiers?.shift) {
      // Add without toggling: the toggle is decided on release, so a shift+drag
      // can carry the tile it just added to the set.
      if (!pressWasSelected) addToSelection(id)
    } else if (!pressWasSelected) {
      // A press on a selected tile keeps the whole selection, which is what makes
      // a group drag possible; collapsing a multi-selection waits for the click.
      selectOnly(id)
    }
    state.anchorId = id
    schedule()
  },
  click: (id, modifiers) => {
    if (!state.tiles.has(id)) return
    if (modifiers?.shift) {
      if (pressWasSelected) removeFromSelection(id)
      return
    }
    if (state.selected.size > 1) selectOnly(id)
  },
  beginMove: (id) => {
    // Everything selected moves, or just this tile when the press was on an
    // unselected one (a drag started with a plain press is still a selection of
    // one). Origins are frozen here, at press time.
    const group = state.selected.has(id) ? [...state.selected] : [id]
    const origins = new Map<string, Rect>()
    for (const tid of group) {
      const tile = state.tiles.get(tid)
      if (tile) origins.set(tid, { ...tile.world })
    }
    state.move = origins
    state.anchorId = id
  },
  moveBy: (_id, dx, dy) => {
    const origins = state.move
    if (origins === null) return
    for (const [tid, origin] of origins) {
      const tile = state.tiles.get(tid)
      if (tile) tile.world = translateRect(origin, dx, dy)
    }
    schedule()
  },
  endMove: () => {
    state.move = null
  },
  close: (id) => destroyTile(id),
  command: (id, command) => bridge.command(id, command),
  fit: (id) => {
    fitTile(id)
  },
  toggleDark: (id) => {
    const tile = state.tiles.get(id)
    if (!tile) return
    void bridge
      .setTileDark(id, !tile.darkMode)
      .then((answer) => {
        // What main reached, not what was asked: a refused insert leaves the page light,
        // and a button that flipped on the press would be claiming otherwise.
        tile.setDarkMode(answer.on)
        if (answer.error) console.warn(`[canvas] dark mode: ${answer.error}`)
        // The flag is part of the saved record, so the inventory is what carries it to
        // the rest of the chrome.
        pushInventory()
      })
      .catch((error: unknown) => console.warn('[canvas] dark mode failed:', error))
  },
  clip: (id) => {
    const tile = state.tiles.get(id)
    if (!tile) return
    void bridge
      .clipTile(id)
      .then((result) => {
        tile.pulseClip(result.ok)
        if (!result.ok) console.warn(`[canvas] clip failed: ${result.error ?? 'unknown'}`)
      })
      .catch((error: unknown) => {
        tile.pulseClip(false)
        console.warn('[canvas] clip failed:', error)
      })
  },
  toggleBookmark: (id) => {
    const tile = state.tiles.get(id)
    if (!tile) return
    void bridge
      .toggleBookmark({ url: tile.url, title: tile.title, container: tile.partition })
      .then((answer) => {
        // Main answered: the star paints what the file reached, not what was asked. The
        // broadcast that follows refreshes every other tile and the shelf, so this is
        // the fast path and not a second source of truth.
        tile.setBookmarked(answer.bookmarked)
        if (answer.error) console.warn(`[canvas] bookmark: ${answer.error}`)
      })
      .catch((error: unknown) => console.warn('[canvas] bookmark failed:', error))
  },
  changed: () => schedule(),
}

function spawnTile(record: TileRecord): Tile {
  const tile = new Tile(record, hooks)
  state.tiles.set(record.id, tile)
  tilesEl.append(tile.el)
  state.stack = [...state.stack, record.id]
  raiseToFront(tile)
  // A restored workspace is spawned before or after the bookmark list arrives; the set
  // is the authority either way, so the star is right at boot and after a reload.
  tile.setBookmarked(state.bookmarkKeys.has(bookmarkKey(record.url)))

  const layout = layoutTile(record.world, state.viewport)
  bridge.createTile({
    id: record.id,
    url: record.url,
    bounds: layout.content,
    zoom: state.viewport.zoom,
    // The tile's own (normalised) container, not the raw record: the pill in the
    // chrome and the session the view runs on come from one value.
    partition: tile.partition,
    // The view has to be built dark, or the first document loads light and the
    // stylesheet arrives after it settles.
    dark: tile.darkMode,
  })
  state.sent.set(record.id, boundsKey(layout.content, state.viewport.zoom))
  schedule()
  return tile
}

function destroyTile(id: string): void {
  const tile = state.tiles.get(id)
  if (!tile) return
  state.tiles.delete(id)
  state.sent.delete(id)
  // The list is the paint order, so a closed tile leaves it too; an id left behind
  // would be a row in the layer panel pointing at nothing.
  state.stack = state.stack.filter((entry) => entry !== id)
  // The node is about to be removed, so no un-highlight is needed; the set just
  // has to stop naming a tile that no longer exists.
  state.selected.delete(id)
  state.move?.delete(id)
  if (state.anchorId === id) state.anchorId = [...state.selected].pop() ?? null
  tile.el.remove()
  bridge.destroyTile(id)
  schedule()
}

/**
 * Re-open a tile in another container.
 *
 * A partition is a `webPreferences` value Chromium reads when the view is
 * constructed, so a live WebContentsView cannot change jar: there is no
 * `setPartition` on the Electron side, and the session object a view reports never
 * moves. The move is therefore a rebuild on the same tile id — the DOM element and
 * the world rect survive, the page starts over in the new jar, which is what
 * "move into another container" has to mean.
 *
 * Two details are load-bearing:
 *
 * - the `sent` bound-key entry is deleted first, because a rebuilt view has no
 *   bounds and the frame pipeline only sends a rect whose `(x,y,w,h)@zoom` key
 *   changed — leaving the stale key in place would hand the new view a 0×0 rect;
 * - the tile ends up in front in all three places — inline z-index, layer list and
 *   view stack — because `addChildView` puts the new view on top while nothing else
 *   has moved, so leaving the z-order alone would let the two layers disagree about
 *   which tile is front. That is what `hooks.focus` does, and it is why a container
 *   move also moves the tile to the front of the layer list.
 */
function repartitionTile(id: string, partition: string): { ok: boolean; error?: string } {
  const tile = state.tiles.get(id)
  if (!tile) return { ok: false, error: 'no such tile' }
  // Already in the requested jar: nothing to rebuild, and destroying a healthy
  // view to recreate it on the same partition would only cost a page reload.
  if (!tile.setPartition(partition)) return { ok: true }

  bridge.destroyTile(id)
  state.sent.delete(id)
  const layout = layoutTile(tile.world, state.viewport)
  bridge.createTile({
    id,
    url: tile.url,
    bounds: layout.content,
    zoom: state.viewport.zoom,
    partition: tile.partition,
    // A container move rebuilds the view, so the dark stylesheet has to be asked for
    // again: the flag travels with the tile, the inserted sheet does not.
    dark: tile.darkMode,
  })
  state.sent.set(id, boundsKey(layout.content, state.viewport.zoom))
  hooks.focus(id)
  pushInventory()
  return { ok: true }
}

// --------------------------------------------------------------- frame model

function newFrameId(): string {
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  return `frame-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/**
 * The zone owns its rectangle; the canvas owns the tiles. A drag asks the canvas
 * to snapshot what it is carrying (once, on press) and then to move that
 * snapshot, so the model stays in one place and a tile can never join the set
 * halfway through the gesture.
 */
const frameHooks: FrameHooks = {
  requestFrame: schedule,
  zoom: () => state.viewport.zoom,
  beginCarry: (world) => {
    const inside = idsInsideFrame(
      world,
      [...state.tiles.values()].map((tile) => ({ id: tile.id, world: tile.world })),
    )
    const origins = new Map<string, Rect>()
    for (const id of inside) {
      const tile = state.tiles.get(id)
      if (tile) origins.set(id, { ...tile.world })
    }
    state.carry = { ids: inside, origins }
  },
  carryBy: (dx, dy) => {
    const carry = state.carry
    if (!carry) return
    for (const id of carry.ids) {
      const tile = state.tiles.get(id)
      const origin = carry.origins.get(id)
      if (!tile || !origin) continue
      tile.world = translateRect(origin, dx, dy)
    }
  },
  endCarry: () => {
    state.carry = null
  },
  commit: () => schedule(),
  // The zone has already renamed itself; the canvas only needs to notice.
  rename: () => schedule(),
  remove: (id) => destroyFrame(id),
}

function spawnFrame(record: FrameRecord): Frame {
  const zone = new Frame(record, frameHooks)
  state.frames.set(record.id, zone)
  framesEl.append(zone.el)
  zone.applyLayout(state.viewport)
  schedule()
  return zone
}

function destroyFrame(id: string): void {
  const zone = state.frames.get(id)
  if (!zone) return
  state.frames.delete(id)
  zone.el.remove()
  schedule()
}

/**
 * ⌘G: draw a zone around every tile on the canvas.
 *
 * There is no multi-select yet, so "the selection" is at most one tile and a
 * frame around it would be decorative. Framing everything is the action that is
 * useful on a canvas: label where the work is, then resize the zone if it needs
 * a tighter fit. An empty canvas still gets a zone at the viewport centre, so the
 * shortcut is never a silent no-op.
 */
function drawFrame(): boolean {
  // The same cap the loader enforces: minting past it would only lose zones on
  // the next save, silently.
  if (state.frames.size >= MAX_FRAMES_PER_WORKSPACE) return false
  // A frame covers the selection when there is one, and every tile when there is
  // not. With a subset picked, "frame what I selected" is the only useful reading;
  // framing the whole canvas stays the answer for an empty selection, which is
  // also what the shortcut did before selection could hold more than one tile.
  const items = [...state.tiles.values()].map((tile) => ({ id: tile.id, world: tile.world }))
  const centre = worldAtViewportCenter()
  const bounds =
    groupBounds(items, state.selected) ?? { x: centre.x - 320, y: centre.y - 220, width: 640, height: 440 }
  const padded = padRect(bounds, FRAME_PADDING_WORLD)
  spawnFrame({
    id: newFrameId(),
    name: `Frame ${state.frames.size + 1}`,
    worldX: Math.round(padded.x),
    worldY: Math.round(padded.y),
    worldW: Math.round(padded.width),
    worldH: Math.round(padded.height),
  })
  return true
}

function worldAtViewportCenter(): Point {
  return screenToWorldPoint({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, state.viewport)
}

/**
 * Where a new tile lands: centred on the anchor when that space is free, and
 * cascaded off the last focused tile when it is not.
 *
 * The cascade is not cosmetic. Tile chrome is canvas DOM and every tile's
 * WebContentsView paints over it, so a tile spawned on top of another one has a
 * title bar that nothing can click — the window is trapped. `placeNewTile()`
 * refuses to overlap, which is the only reliable fix: raise-on-click cannot
 * rescue chrome that the pointer never reaches.
 */
function newTileWorld(anchor: Point): Rect {
  const wanted: Rect = {
    x: Math.round(anchor.x - DEFAULT_TILE_WORLD_W / 2),
    y: Math.round(anchor.y - DEFAULT_TILE_WORLD_H / 2),
    width: DEFAULT_TILE_WORLD_W,
    height: DEFAULT_TILE_WORLD_H,
  }
  const focused = state.anchorId === null ? null : state.tiles.get(state.anchorId)?.world ?? null
  const occupied = [...state.tiles.values()].map((tile) => tile.world)
  return placeNewTile(wanted, focused, occupied)
}

function createTileAt(url: string, anchor: Point, requestedPartition?: string): Tile {
  // The partition arrives as a renderer-supplied string, so it goes through the
  // same validation main applies. A default tile writes no `partition` field at
  // all, which keeps a shared-jar record byte-identical to the pre-container
  // format; a container's string is saved verbatim so a reload reopens the jar.
  const partition = normalizeTilePartition(requestedPartition)
  const record: TileRecord = { id: newTileId(), url, title: '', world: newTileWorld(anchor) }
  if (partition !== DEFAULT_TILE_PARTITION) record.partition = partition
  const tile = spawnTile(record)
  selectOnly(record.id)
  return tile
}

// ------------------------------------------------------------------ camera

/** Flies the camera so `id` sits in the middle of the window, at current zoom. */
function centerOnTile(id: string): boolean {
  const tile = state.tiles.get(id)
  if (!tile) return false
  return animateCameraTo(panTileToCenter(tile.world, state.viewport, viewSize()))
}

/**
 * The green light: centre `id` in the window and pick the zoom that shows the
 * whole tile with padding. This moves the camera, never the tile — the tile's
 * world rect is the user's and a fit must not rewrite it.
 */
function fitTile(id: string): boolean {
  const tile = state.tiles.get(id)
  if (!tile) return false
  return animateCameraTo(fitToView([tile.world], state.viewport, viewSize(), FIT_PADDING))
}

function fitAll(): boolean {
  cancelCamera()
  const next = fitToView(
    [...state.tiles.values()].map((tile) => tile.world),
    state.viewport,
    viewSize(),
    FIT_PADDING,
  )
  if (!next) return false
  state.viewport = next
  schedule()
  return true
}

function zoomReset(): void {
  state.viewport = resetZoom(state.viewport, viewSize())
  schedule()
}

// -------------------------------------------------------------- workspaces

/**
 * Paint a theme onto this document and tell main what was painted.
 *
 * The canvas and the chrome are different documents in different views, so there is
 * no cascade to inherit: the theme is three custom properties set here, and the same
 * three are set in the overlay by the same values arriving over IPC.
 *
 * `echo` is false for a theme that came from main. Rebroadcasting a broadcast is a
 * loop, and main already coerced and holds exactly that object.
 */
function applyTheme(theme: WorkspaceTheme, echo = true): void {
  state.theme = theme
  canvasEl.style.setProperty('--theme-gradient', buildCssGradient(theme.colors, theme.angle))
  // The chrome tints itself from this one stop; falling back keeps a theme with a
  // single usable colour from painting an empty var.
  canvasEl.style.setProperty('--theme-base', theme.colors[0] ?? DEFAULT_THEME.colors[0]!)
  canvasEl.style.setProperty('--theme-grain-opacity', String(theme.grain / 100))
  if (echo) bridge.updateTheme(theme)
}

function collectSnapshot(): CanvasSnapshot {
  return {
    viewport: { ...state.viewport },
    tiles: [...state.tiles.values()].map((tile) => ({
      id: tile.id,
      url: tile.url,
      title: tile.title,
      // Undefined for a default tile, which keeps the saved file free of a
      // partition field it does not need.
      partition: tile.partition,
      // Same absence rule: a light tile writes no `darkMode` key at all, so a workspace
      // nobody darkened stays byte-identical to what it was before this feature.
      darkMode: tile.darkMode || undefined,
      world: { ...tile.world },
    })),
    // Zones are annotation, so they are written as-is; main validates them the
    // same way it validates tiles before either reaches a file.
    frames: [...state.frames.values()].map((zone) => zone.record()),
    // Painting order, back to front. Sent every time and dropped by main when it
    // still matches creation order, which is how a workspace nobody re-ordered keeps
    // writing no `stack` key at all.
    stack: [...state.stack],
    // The theme goes back exactly as it came in: main coerces it on both sides, so
    // an untouched workspace still writes no theme key at all.
    theme: state.theme,
  }
}

function applyWorkspace(workspace: WorkspaceState): void {
  for (const tile of state.tiles.values()) {
    bridge.destroyTile(tile.id)
    tile.el.remove()
  }
  state.tiles.clear()
  state.sent.clear()
  for (const zone of state.frames.values()) zone.el.remove()
  state.frames.clear()
  state.carry = null
  state.selected = new Set()
  state.anchorId = null
  state.move = null
  state.stack = []
  state.inventoryKey = ''
  state.workspace = workspace.name
  state.viewport = { ...workspace.viewport }
  state.theme = resolveTheme(workspace.theme)
  applyTheme(state.theme)
  for (const record of workspace.frames ?? []) spawnFrame(record)
  // Spawn in painting order, back to front: the spawn sequence *is* the view stack
  // and the z-index sequence, so a restored workspace needs no re-order RPC at all.
  // A record the order forgot is appended by the validator, never dropped.
  const byId = new Map(workspace.tiles.map((record) => [record.id, record]))
  const order = normalizeLayerOrder(
    workspace.stack,
    workspace.tiles.map((record) => record.id),
  ) ?? workspace.tiles.map((record) => record.id)
  for (const id of order) {
    const record = byId.get(id)
    if (record) spawnTile(record)
  }
  // A load is not an edit: the frame that paints these tiles must not be saved back.
  armAutosave()
  schedule()
  pushStatus()
}

function resetToScratch(): void {
  state.workspace = 'scratch'
  state.viewport = { panX: 140, panY: 120, zoom: 1 }
  applyTheme(resolveTheme(undefined))
  armAutosave()
  schedule()
  pushStatus()
}

// -------------------------------------------------------------------- input

const api: InputApi = {
  pan: (dx, dy) => {
    cancelCamera()
    state.viewport = panByScreen(state.viewport, dx, dy)
    schedule()
  },
  zoomAt: (point, factor) => {
    cancelCamera()
    state.viewport = zoomAtPoint(state.viewport, point, factor)
    schedule()
  },
  openPalette: (screenPoint) => {
    const point = screenPoint ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    bridge.requestOverlay('omnibox', screenToWorldPoint(point, state.viewport))
  },
  collapsePalette: () => bridge.requestOverlay('compact'),
  saveWorkspace: () => {
    void bridge.saveWorkspace(state.workspace, collectSnapshot())
  },
  openDock: () => bridge.requestDockFocus(),
  toggleSidebar: () => bridge.toggleSidebar(),
  clearSelection: () => clearSelection(),
  marquee,
  fitAll,
  drawFrame,
}

// ---------------------------------------------------------------------- rpc

interface CreateAtPayload {
  url: string
  world: Point | null
  /** Container the tile should open in; absent means the shared jar. */
  partition?: string
}

bridge.onRuntime((runtime) => {
  const tile = state.tiles.get(runtime.id)
  if (!tile) return
  tile.setRuntime(runtime)
  // The runtime is where a navigation shows up, so this is where the star is re-asked:
  // a page that redirected to a saved URL lights up, and one that navigated away from a
  // saved URL does not keep wearing its star.
  tile.setBookmarked(state.bookmarkKeys.has(bookmarkKey(tile.url)))
  pushInventory()
  // A navigation rewrites the URL the workspace file stores for this tile, and nothing
  // about it reaches `frame()` (no geometry moved) — so it is reported here or it is not
  // persisted until the next unrelated change.
  reportDirty()
})

bridge.onOpenRequest((url, partition) => {
  const normalized = normalizeUrl(url)
  // A popup stays in the same container as the tile that opened it: a login
  // popup from a work tile must not land in the shared jar.
  if (normalized) createTileAt(normalized, worldAtViewportCenter(), partition)
})

// Pan deltas originate in the overlay's interceptor; main forwards them only
// while the interceptor is armed, so no arming check is needed here.
bridge.onPan((delta) => {
  cancelCamera()
  state.viewport = panByScreen(state.viewport, delta.dx, delta.dy)
  schedule()
})

// A theme from main is painted and never echoed back: main is where every theme is
// coerced, and rebroadcasting a broadcast would be a loop.
bridge.onTheme((theme) => applyTheme(theme, false))

// Bookmarks arrive the same way: one push from main after any change, whoever made it.
bridge.onBookmarks((list) => applyBookmarks(list))

function answerRpc(message: CanvasRpc, value: unknown): void {
  bridge.replyRpc(message.id, value)
}

bridge.onRpc((message) => {
  try {
    switch (message.op) {
      case 'collect': {
        // The workspace name travels with the snapshot: main's copy of it lags a switch by
        // one IPC hop, and a write aimed with the stale name lands in the workspace the
        // user just left.
        answerRpc(message, { ...collectSnapshot(), workspace: state.workspace })
        return
      }
      case 'apply': {
        applyWorkspace(message.payload as WorkspaceState)
        answerRpc(message, { ok: true })
        return
      }
      case 'createAt': {
        const payload = message.payload as CreateAtPayload
        createTileAt(payload.url, payload.world ?? worldAtViewportCenter(), payload.partition)
        answerRpc(message, { ok: true })
        return
      }
      case 'focusTile': {
        const id = (message.payload as { id?: string } | undefined)?.id
        const tile = id ? state.tiles.get(id) : undefined
        if (tile) {
          // A row press in the chrome is a press: it raises in both layers and then
          // centres the tile. Selection is deliberately untouched — a row click pans
          // without changing what is selected — but the paint order is the canvas's,
          // so main must not raise the view on its own and leave the two layers
          // describing different fronts.
          raiseToFront(tile)
          bridge.focusTile(tile.id)
          pushInventory()
        }
        answerRpc(message, { ok: id ? centerOnTile(id) : false })
        return
      }
      case 'closeTile': {
        const id = (message.payload as { id?: string } | undefined)?.id
        if (id) destroyTile(id)
        answerRpc(message, { ok: Boolean(id) })
        return
      }
      case 'moveTile': {
        const payload = message.payload as { id?: string; partition?: string } | undefined
        if (!payload?.id) {
          answerRpc(message, { ok: false, error: 'no tile id' })
          return
        }
        answerRpc(message, repartitionTile(payload.id, payload.partition ?? DEFAULT_TILE_PARTITION))
        return
      }
      case 'layerOrder': {
        const payload = message.payload as { id?: string; to?: string } | undefined
        if (!payload?.id) {
          answerRpc(message, { ok: false, error: 'no tile id' })
          return
        }
        // Two named ends and nothing else: the request arrives from main, which has
        // already validated it, but this is the module that acts, so it refuses too.
        if (payload.to !== 'front' && payload.to !== 'back') {
          answerRpc(message, { ok: false, error: `"${payload.to ?? ''}" is not a layer position` })
          return
        }
        answerRpc(message, setLayerOrder(payload.id, payload.to))
        return
      }
      case 'zoomReset': {
        zoomReset()
        answerRpc(message, { ok: true })
        return
      }
      case 'fitAll': {
        answerRpc(message, { ok: fitAll() })
        return
      }
      default: {
        answerRpc(message, { ok: false, error: `unknown op ${String(message.op)}` })
      }
    }
  } catch (error) {
    answerRpc(message, { ok: false, error: String(error) })
  }
})

// --------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  installInput(canvasEl, api)
  window.addEventListener('resize', schedule)
  // Paint before anything is loaded: the default theme is a real theme, and the
  // overlay learns it from the echo rather than guessing its own starting tint.
  applyTheme(state.theme)

  // Bookmarks before the workspace: restoring a workspace spawns tiles, and every spawn
  // asks this set whether its page is saved. Loading them afterwards would leave each
  // restored tile wearing a hollow star until the next push.
  try {
    applyBookmarks(await bridge.listBookmarks())
  } catch (error) {
    console.warn('[canvas] could not read bookmarks:', error)
  }

  try {
    const session = await bridge.readSession()
    if (session.lastWorkspace) {
      const workspace = await bridge.loadWorkspace(session.lastWorkspace)
      if (workspace) {
        applyWorkspace(workspace)
        return
      }
    }
  } catch (error) {
    console.warn('[canvas] could not restore the last workspace:', error)
  }

  resetToScratch()
}

void boot()
