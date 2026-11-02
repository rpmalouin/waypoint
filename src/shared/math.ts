import {
  CASCADE_MAX_STEPS,
  CASCADE_STEP_WORLD,
  CHROME_MAX_SCREEN_H,
  CHROME_MIN_SCREEN_H,
  CHROME_WORLD_HEIGHT,
  FIT_MAX_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
} from './constants.ts'
import type { Point, Rect, Viewport } from './types.ts'

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/**
 * World → screen: screen = (world + pan) * zoom.
 *
 * Both edges are rounded independently and the size is derived from the rounded
 * edges. Rounding position and size separately (the naive form) leaves one-pixel
 * seams between a tile's DOM chrome and its page view, which show the canvas
 * through the gap. Deriving width from edges keeps neighbouring rects pixel-exact.
 */
export function worldToScreen(world: Rect, viewport: Viewport): Rect {
  const { zoom } = viewport
  const left = Math.round((world.x + viewport.panX) * zoom)
  const top = Math.round((world.y + viewport.panY) * zoom)
  const right = Math.round((world.x + world.width + viewport.panX) * zoom)
  const bottom = Math.round((world.y + world.height + viewport.panY) * zoom)
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  }
}

export function screenToWorld(rect: Rect, viewport: Viewport): Rect {
  const { zoom } = viewport
  return {
    x: rect.x / zoom - viewport.panX,
    y: rect.y / zoom - viewport.panY,
    width: rect.width / zoom,
    height: rect.height / zoom,
  }
}

export function screenToWorldPoint(point: Point, viewport: Viewport): Point {
  return {
    x: point.x / viewport.zoom - viewport.panX,
    y: point.y / viewport.zoom - viewport.panY,
  }
}

/** A screen-space drag moves the world by delta/zoom. */
export function panByScreen(viewport: Viewport, dx: number, dy: number): Viewport {
  return {
    zoom: viewport.zoom,
    panX: viewport.panX + dx / viewport.zoom,
    panY: viewport.panY + dy / viewport.zoom,
  }
}

/**
 * Zoom about a screen point, keeping the world point under the cursor fixed.
 * With screen = (world + pan) * zoom, the world point under `point` is
 * point/zoom - pan, so pan' = point/zoom' - (point/zoom - pan).
 */
export function zoomAtPoint(viewport: Viewport, point: Point, factor: number): Viewport {
  const zoom = clampZoom(viewport.zoom * factor)
  if (zoom === viewport.zoom) return viewport
  const k = 1 / zoom - 1 / viewport.zoom
  return {
    zoom,
    panX: viewport.panX + point.x * k,
    panY: viewport.panY + point.y * k,
  }
}

export interface TileLayout {
  /** Full tile footprint on screen, including the chrome bar. */
  tile: Rect
  chrome: Rect
  /** The area handed to the WebContentsView. */
  content: Rect
  chromeVisible: boolean
  /** True when the frame is down to its title bar and the page has no pixels. */
  collapsed: boolean
}

/**
 * Single source of truth for a tile's on-screen geometry: the renderer draws the
 * chrome from `chrome` and the main process sets the view to `content`. Both read
 * the same numbers, so they cannot drift apart.
 */
export function layoutTile(world: Rect, viewport: Viewport): TileLayout {
  const tile = worldToScreen(world, viewport)
  const scaled = Math.round(CHROME_WORLD_HEIGHT * viewport.zoom)
  const preferred = Math.min(CHROME_MAX_SCREEN_H, Math.max(CHROME_MIN_SCREEN_H, scaled))
  // A frame no taller than the bar it draws is collapsed: the bar *is* the tile.
  // The content rect then has no height at all, so the page view can be hidden
  // instead of leaving a sliver of the page showing under the title bar.
  const collapsed = tile.height <= preferred
  const chromeHeight = collapsed ? tile.height : Math.min(preferred, Math.max(1, tile.height - 1))
  return {
    tile,
    chrome: { x: tile.x, y: tile.y, width: tile.width, height: chromeHeight },
    content: {
      x: tile.x,
      y: tile.y + chromeHeight,
      width: tile.width,
      height: collapsed ? 0 : Math.max(1, tile.height - chromeHeight),
    },
    chromeVisible: chromeHeight >= CHROME_MIN_SCREEN_H,
    collapsed,
  }
}

/**
 * Camera easing: cubic in-out, so the first and last frames are slow and a fit
 * reads as a camera move rather than a jump cut.
 */
export function easeCamera(t: number): number {
  const clamped = Math.min(1, Math.max(0, t))
  return clamped < 0.5 ? 4 * clamped ** 3 : 1 - (-2 * clamped + 2) ** 3 / 2
}

/** The viewport `t` of the way from `from` to `to`; pan and zoom move together. */
export function tweenViewport(from: Viewport, to: Viewport, t: number): Viewport {
  const clamped = Math.min(1, Math.max(0, t))
  return {
    panX: from.panX + (to.panX - from.panX) * clamped,
    panY: from.panY + (to.panY - from.panY) * clamped,
    zoom: from.zoom + (to.zoom - from.zoom) * clamped,
  }
}

/**
 * True when two rects share more than an edge. Touching rects do not overlap:
 * a tile flush against another one shows its full chrome.
 */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Shared area of two rects, 0 when they only touch or are apart. */
export function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

/**
 * Where a new tile actually goes.
 *
 * Tile chrome is drawn in the canvas document, and every tile's WebContentsView
 * paints *over* that document. So a tile that lands on top of another one has
 * its title bar covered by the other tile's page: it cannot be dragged, resized
 * or closed, and the canvas offers no way to reach it. Placement therefore
 * refuses to overlap at all, rather than relying on click-to-raise that a
 * covered chrome can never receive.
 *
 * `wanted` is the rect the caller would use on an empty canvas (usually centred
 * on the viewport). When it collides with `occupied`, the tile cascades by
 * `step` from `anchor` — the last focused tile — first rightwards, then down,
 * then diagonally, and takes the first slot that clears every existing tile.
 * With equal-sized tiles the first clear rightward slot is the adjacent one, so
 * a spawn reads as "next to the tile you were in" rather than a pile. If every
 * slot is taken, the least-overlapping one wins, so this always returns a
 * usable rect.
 */
export function placeNewTile(
  wanted: Rect,
  anchor: Rect | null,
  occupied: readonly Rect[],
  step: number = CASCADE_STEP_WORLD,
  maxSteps: number = CASCADE_MAX_STEPS,
): Rect {
  if (!Number.isFinite(wanted.x) || !Number.isFinite(wanted.y)) return wanted
  const overlapOf = (rect: Rect): number => occupied.reduce((sum, other) => sum + overlapArea(rect, other), 0)
  const overlap = overlapOf(wanted)
  if (overlap === 0) return wanted

  const base = anchor && intersects(anchor, wanted) ? anchor : wanted
  const stride = Number.isFinite(step) && step > 0 ? step : CASCADE_STEP_WORLD
  const limit = Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : CASCADE_MAX_STEPS

  let best = wanted
  let bestOverlap = overlap
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1]] as const) {
    for (let index = 1; index <= limit; index += 1) {
      const candidate: Rect = {
        x: Math.round(base.x + index * stride * dx),
        y: Math.round(base.y + index * stride * dy),
        width: wanted.width,
        height: wanted.height,
      }
      const candidateOverlap = overlapOf(candidate)
      if (candidateOverlap === 0) return candidate
      if (candidateOverlap < bestOverlap) {
        best = candidate
        bestOverlap = candidateOverlap
      }
    }
  }
  return best
}

/**
 * Pan that puts the world point `world` at the centre of a `view`-sized window.
 * With screen = (world + pan) * zoom, centring means (world + pan) * zoom = view/2.
 * Zoom is preserved: this only moves the camera.
 */
export function panToCenter(world: Point, viewport: Viewport, view: { width: number; height: number }): Viewport {
  const zoom = clampZoom(viewport.zoom)
  return {
    zoom,
    panX: view.width / (2 * zoom) - world.x,
    panY: view.height / (2 * zoom) - world.y,
  }
}

/** Same camera move, computed from a tile rect: centre on the tile's midpoint. */
export function panTileToCenter(
  world: Rect,
  viewport: Viewport,
  view: { width: number; height: number },
): Viewport {
  return panToCenter({ x: world.x + world.width / 2, y: world.y + world.height / 2 }, viewport, view)
}

/**
 * Zoom to just far enough that every rect fits inside `view` with `padding` on
 * each side, then centre the bounding box. The zoom is capped at `FIT_MAX_ZOOM`
 * (1.5x) so a fit can frame a single small tile without blowing it up to the
 * window, and floored at `MIN_ZOOM` by `clampZoom`. Returns null when there is
 * nothing to fit, so callers can leave the viewport untouched.
 */
export function fitToView(
  worlds: Rect[],
  viewport: Viewport,
  view: { width: number; height: number },
  padding: number,
): Viewport | null {
  if (worlds.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const rect of worlds) {
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) continue
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null

  const boxWidth = Math.max(1, maxX - minX)
  const boxHeight = Math.max(1, maxY - minY)
  const availableWidth = Math.max(1, view.width - padding * 2)
  const availableHeight = Math.max(1, view.height - padding * 2)
  const zoom = clampZoom(Math.min(FIT_MAX_ZOOM, availableWidth / boxWidth, availableHeight / boxHeight))
  const centre = { x: minX + boxWidth / 2, y: minY + boxHeight / 2 }
  return panToCenter(centre, { ...viewport, zoom }, view)
}

/** Back to 100% while keeping whatever is under the view's centre in place. */
export function resetZoom(viewport: Viewport, view: { width: number; height: number }): Viewport {
  const zoom = 1
  if (viewport.zoom === zoom) return viewport
  const centre = screenToWorldPoint({ x: view.width / 2, y: view.height / 2 }, viewport)
  return panToCenter(centre, { ...viewport, zoom }, view)
}

export type Corner = 'nw' | 'ne' | 'se' | 'sw'

/**
 * Free resize from one corner, anchored at the opposite one.
 *
 * Each axis is independent: dragging `se` changes width and height, `nw` changes
 * position *and* size (the south-east corner does not move), and `ne`/`sw` change
 * one axis each way. The minimum is applied after the raw delta, so a handle
 * dragged past the minimum pins the moving edge at `min*` from the anchor rather
 * than letting the rect flip through itself.
 */
export function resizeFree(
  origin: Rect,
  corner: Corner,
  dx: number,
  dy: number,
  minWidth: number,
  minHeight: number,
): Rect {
  const movesLeft = corner === 'nw' || corner === 'sw'
  const movesUp = corner === 'nw' || corner === 'ne'
  const movesRight = corner === 'ne' || corner === 'se'
  const movesDown = corner === 'sw' || corner === 'se'

  // The two edges the handle does not touch. They are what "anchor" means here.
  const anchorX = movesLeft ? origin.x + origin.width : origin.x
  const anchorY = movesUp ? origin.y + origin.height : origin.y

  const width = Math.max(minWidth, Math.round(origin.width + (movesRight ? dx : -dx)))
  const height = Math.max(minHeight, Math.round(origin.height + (movesDown ? dy : -dy)))

  return {
    x: Math.round(movesLeft ? anchorX - width : anchorX),
    y: Math.round(movesUp ? anchorY - height : anchorY),
    width,
    height,
  }
}

// ------------------------------------------------------------------ frames

/** A frame record's world rect, in the shape the rest of the geometry code uses. */
export function frameRect(frame: { worldX: number; worldY: number; worldW: number; worldH: number }): Rect {
  return { x: frame.worldX, y: frame.worldY, width: frame.worldW, height: frame.worldH }
}

export function rectCentre(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/**
 * Inclusive containment: a tile whose centre lands exactly on a frame edge is
 * inside it. Inclusive on purpose — the alternative is a tile that belongs to
 * neither of two touching frames, which reads as a bug to whoever dragged it.
 */
export function containsPoint(frame: Rect, point: Point): boolean {
  return (
    point.x >= frame.x &&
    point.x <= frame.x + frame.width &&
    point.y >= frame.y &&
    point.y <= frame.y + frame.height
  )
}

/**
 * The ids a frame drag carries: everything whose *centre* is inside the zone.
 * Centre rather than top-left, so a tile straddling the border follows the zone
 * it looks like it belongs to.
 */
export function idsInsideFrame(frame: Rect, items: { id: string; world: Rect }[]): string[] {
  return items.filter((item) => containsPoint(frame, rectCentre(item.world))).map((item) => item.id)
}

/**
 * Items a rubberband rect touches, in world units.
 *
 * The marquee is drawn in screen space and converted to world before it arrives
 * here, so the hit test never sees a zoom factor: the same box drawn over a tile
 * at 0.25x and at 2x selects the same items. Overlap is strict (the `intersects()`
 * rule), so a box that only shares an edge with a tile leaves it unselected — the
 * same reason a tile flush against another keeps its full chrome.
 *
 * Deliberately different from `idsInsideFrame()`: a frame carries what it
 * *contains* (centre inside), while a rubberband selects what it *covers*, which
 * is what makes dragging a large box over a row of tiles feel right.
 */
export function marqueeHits(marquee: Rect, items: readonly { id: string; world: Rect }[]): string[] {
  const hits: string[] = []
  for (const item of items) {
    if (intersects(marquee, item.world)) hits.push(item.id)
  }
  return hits
}

/**
 * The world rect a group frame should cover: the selected items when there is a
 * selection, otherwise every item.
 *
 * Null only when there is nothing to bound — no items at all, or a selection whose
 * ids no longer address one (a stale set after a delete). The caller keeps its own
 * fallback for that case rather than this function inventing a rect the user never
 * asked for.
 */
export function groupBounds(
  items: readonly { id: string; world: Rect }[],
  selected: ReadonlySet<string>,
): Rect | null {
  const chosen = selected.size > 0 ? items.filter((item) => selected.has(item.id)) : items
  if (chosen.length === 0) return null
  return rectUnion(chosen.map((item) => item.world))
}

export function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return { x: Math.round(rect.x + dx), y: Math.round(rect.y + dy), width: rect.width, height: rect.height }
}

/** Smallest rect containing every input; null when there is nothing to bound. */
export function rectUnion(rects: Rect[]): Rect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const rect of rects) {
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) continue
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

/** Grow a rect by `by` on every side; a negative value shrinks it, never below 1. */
export function padRect(rect: Rect, by: number): Rect {
  return {
    x: Math.round(rect.x - by),
    y: Math.round(rect.y - by),
    width: Math.max(1, Math.round(rect.width + by * 2)),
    height: Math.max(1, Math.round(rect.height + by * 2)),
  }
}

/** Host portion of a URL, `www.` stripped, for labelling tiles and sidebar rows. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

/** Single letter shown in the favicon slot when no real icon is available. */
export function faviconLetter(url: string): string {
  const host = hostLabel(url).replace(/^[^a-z0-9]+/i, '')
  const letter = host.charAt(0) || '?'
  return letter.toUpperCase()
}

/** Stable hue (0-359) from a string, so each host always gets the same tint. */
export function hueFor(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 360
  return hash
}

/** What a title bar or sidebar row shows when a page has no title yet. */
export function displayTitle(title: string, url: string): string {
  const trimmed = title.trim()
  if (trimmed) return trimmed
  return hostLabel(url) || url.trim() || 'New tile'
}

export function rectKey(rect: Rect): string {
  return `${rect.x},${rect.y},${rect.width},${rect.height}`
}

export function boundsKey(rect: Rect, zoom: number): string {
  return `${rectKey(rect)}@${zoom.toFixed(3)}`
}

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export interface WheelLike {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export type WheelIntent =
  | { kind: 'zoom'; factor: number }
  | { kind: 'pan'; dx: number; dy: number }

const LINE_PX = 16
const PAGE_PX = 400
/** Per-notch gain for a discrete mouse wheel. */
const WHEEL_ZOOM_GAIN = 0.0025
/** Per-pixel gain for trackpad pinch (which arrives as ctrl+wheel). */
const PINCH_ZOOM_GAIN = 0.01
/** One gesture must never jump more than this factor. */
const MAX_SINGLE_FACTOR = 2

/**
 * Trackpads and mice both deliver `wheel`. A discrete wheel reports whole
 * notches (deltaMode line/page, or integer pixel deltas of a full click) and
 * means zoom; a trackpad reports small fractional pixel deltas and means pan.
 * ctrl/meta (pinch, ⌘-scroll) always means zoom.
 */
export function classifyWheel(event: WheelLike): WheelIntent {
  const scale = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? PAGE_PX : 1
  const dx = event.deltaX * scale
  const dy = event.deltaY * scale
  const gesture = event.ctrlKey || event.metaKey
  const notched =
    event.deltaMode !== 0 ||
    (Number.isInteger(dy) && Math.abs(dy) >= 40 && Math.abs(dx) < 1)

  if (gesture || notched) {
    const gain = gesture ? PINCH_ZOOM_GAIN : WHEEL_ZOOM_GAIN
    const factor = Math.exp(-dy * gain)
    return { kind: 'zoom', factor: Math.min(MAX_SINGLE_FACTOR, Math.max(1 / MAX_SINGLE_FACTOR, factor)) }
  }

  const shiftOnly = event.shiftKey && dx === 0
  return {
    kind: 'pan',
    dx: -(shiftOnly ? dy : dx),
    dy: shiftOnly ? 0 : -dy,
  }
}

export const SEARCH_TEMPLATE = 'https://duckduckgo.com/?q='

/**
 * Turns omnibox input into a navigable URL. There is no search provider baked in
 * except SEARCH_TEMPLATE, and it is only used when the input is plainly a phrase.
 */
export function normalizeUrl(raw: string): string {
  const input = raw.trim()
  if (!input) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) return input
  if (/^(about|data|file|view-source):/i.test(input)) return input
  if (/\s/.test(input)) return SEARCH_TEMPLATE + encodeURIComponent(input)
  if (/^(localhost|\[[0-9a-f:]+\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(input)) return `http://${input}`
  if (input.includes('.')) return `https://${input}`
  return SEARCH_TEMPLATE + encodeURIComponent(input)
}

const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'about:', 'data:'])

/** Trust boundary for anything a compromised renderer asks a tile to load. */
export function isNavigableUrl(raw: string): boolean {
  try {
    return NAVIGABLE_PROTOCOLS.has(new URL(raw).protocol)
  } catch {
    return false
  }
}
