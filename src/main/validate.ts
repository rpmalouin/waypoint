import { TILE_ID_RE } from '../shared/constants.ts'
import { DEFAULT_TILE_PARTITION, normalizeTilePartition } from '../shared/session-partition.ts'
import type { Point, Rect, TileBoundsUpdate, TileSummary } from '../shared/types.ts'

const BOUND_LIMIT = 32000

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Clamp to a rectangle the compositor can actually use. Anything the renderer
 * sends is untrusted input: a NaN or a 10^9-wide view stalls the whole window.
 * Zero is allowed for width and height because a collapsed tile has no content
 * rect; one pixel of dead space is still a rect, so the size is passed through
 * as sent and the caller decides whether the view should be visible at all.
 */
export function asRect(value: unknown): Rect | null {
  const record = asRecord(value)
  if (!record) return null
  const x = asNumber(record.x)
  const y = asNumber(record.y)
  const width = asNumber(record.width)
  const height = asNumber(record.height)
  if (x === null || y === null || width === null || height === null) return null
  const clamp = (n: number, min: number): number =>
    Math.min(BOUND_LIMIT, Math.max(min, Math.round(n)))
  return { x: clamp(x, -BOUND_LIMIT), y: clamp(y, -BOUND_LIMIT), width: clamp(width, 0), height: clamp(height, 0) }
}

export function asPoint(value: unknown): Point | null {
  const record = asRecord(value)
  if (!record) return null
  const x = asNumber(record.x)
  const y = asNumber(record.y)
  return x === null || y === null ? null : { x, y }
}

export function readBoundsUpdates(payload: unknown): TileBoundsUpdate[] {
  const list = Array.isArray(payload) ? payload : []
  const updates: TileBoundsUpdate[] = []
  for (const entry of list.slice(0, 256)) {
    const record = asRecord(entry)
    if (!record) continue
    const id = asString(record.id)
    const bounds = asRect(record.bounds)
    if (!id || !bounds) continue
    const zoom = asNumber(record.zoom)
    updates.push(zoom === null ? { id, bounds } : { id, bounds, zoom })
  }
  return updates
}

const TITLE_LIMIT = 200
const URL_LIMIT = 2048
const INVENTORY_LIMIT = 256

/**
 * The sidebar's tile list arrives from the canvas renderer, so it is untrusted
 * input even though that renderer is ours: clamp lengths and drop rows that
 * cannot be addressed. Anything with a bad id is dropped rather than repaired,
 * because a repaired id would address the wrong tile when it comes back.
 */
export function readInventory(payload: unknown): TileSummary[] {
  const list = Array.isArray(payload) ? payload : []
  const tiles: TileSummary[] = []
  for (const entry of list.slice(0, INVENTORY_LIMIT)) {
    const record = asRecord(entry)
    if (!record) continue
    const id = asString(record.id)
    if (!id || !TILE_ID_RE.test(id)) continue
    const url = asString(record.url) ?? ''
    const title = asString(record.title) ?? ''
    // A container string from the renderer is normalised exactly as the registry
    // would normalise it: a row may show a pill, never invent a jar.
    const partition = normalizeTilePartition(asString(record.partition))
    // Painting order, 0 = furthest back. A missing or nonsensical value reads as
    // the bottom instead of dropping the row: the layer list must still name every
    // tile the canvas has, and a tile with no order would be a row with no place.
    const layer = asNumber(record.layer)
    const summary: TileSummary = {
      id,
      title: title.slice(0, TITLE_LIMIT),
      url: url.slice(0, URL_LIMIT),
      selected: record.selected === true,
      loading: record.loading === true,
      failed: record.failed === true,
      layer: layer === null ? 0 : Math.max(0, Math.floor(layer)),
    }
    if (partition !== DEFAULT_TILE_PARTITION) summary.partition = partition
    tiles.push(summary)
  }
  return tiles
}

/** A tile id used to address one specific view; bad ids are dropped, not fixed. */
export function readTileId(payload: unknown): string | null {
  const id = asString(asRecord(payload)?.id)
  return id && TILE_ID_RE.test(id) ? id : null
}

/**
 * A painting order proposed by the canvas: back-to-front tile ids. Every id is
 * validated and deduped here because the list is applied straight to the child-view
 * stack; an unknown id is dropped rather than trusted, and the registry appends any
 * live tile the list forgot, so a short list can never hide a view.
 */
export function readLayerOrder(payload: unknown): string[] {
  if (!Array.isArray(payload)) return []
  const order: string[] = []
  const seen = new Set<string>()
  for (const entry of payload.slice(0, INVENTORY_LIMIT)) {
    const id = asString(entry)
    if (!id || !TILE_ID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }
  return order
}
