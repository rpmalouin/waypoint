import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveConfigRoot } from './config-root.ts'
import {
  MAX_FRAMES_PER_WORKSPACE,
  MAX_TILES_PER_WORKSPACE,
  MIN_FRAME_WORLD_H,
  MIN_FRAME_WORLD_W,
  MIN_WINDOW_H,
  MIN_WINDOW_W,
  TILE_ID_RE,
} from '../shared/constants.ts'
import { clampZoom, isNavigableUrl } from '../shared/math.ts'
import { isFrameColor } from '../shared/frame-color.ts'
import { normalizeLayerOrder } from '../shared/layers.ts'
import { DEFAULT_TILE_PARTITION, isTilePartition } from '../shared/session-partition.ts'
import { coerceTheme } from '../shared/theme.ts'
import { isValidWorkspaceName } from '../shared/workspace-name.ts'
import type {
  ActionResult,
  CanvasSnapshot,
  FrameRecord,
  Rect,
  SessionInfo,
  TileRecord,
  Viewport,
  WorkspaceState,
} from '../shared/types.ts'
import { asNumber, asRecord, asString } from './validate.ts'

const MAX_FILE_BYTES = 512 * 1024
/** A pause list is a convenience, not a database; it is bounded like everything else. */
const MAX_PAUSED_HOSTS_PERSISTED = 200

function coerceViewport(value: unknown): Viewport {
  const record = asRecord(value)
  return {
    panX: asNumber(record?.panX) ?? 0,
    panY: asNumber(record?.panY) ?? 0,
    zoom: clampZoom(asNumber(record?.zoom) ?? 1),
  }
}

/** The same ceiling `validate.ts` puts on a screen coordinate. */
const MAX_SCREEN_COORD = 32000

/**
 * A remembered window rect, or `undefined` when the session file has nothing usable.
 *
 * `undefined` rather than a clamped guess is the absence-means-default rule the rest
 * of this file follows: a session that never stored geometry must leave the window at
 * its built-in size instead of restoring a rect nobody chose. Whether a well-shaped
 * rect lands on a display that is still attached is main's question — it owns
 * `screen` — so this only answers "is this a rectangle of a usable size".
 */
function coerceWindowBounds(value: unknown): Rect | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const x = asNumber(record.x)
  const y = asNumber(record.y)
  const width = asNumber(record.width)
  const height = asNumber(record.height)
  if (x === null || y === null || width === null || height === null) return undefined
  const clamp = (value: number): number => Math.max(-MAX_SCREEN_COORD, Math.min(MAX_SCREEN_COORD, Math.round(value)))
  return {
    x: clamp(x),
    y: clamp(y),
    width: Math.max(MIN_WINDOW_W, clamp(width)),
    height: Math.max(MIN_WINDOW_H, clamp(height)),
  }
}

function coerceTiles(value: unknown): TileRecord[] {
  if (!Array.isArray(value)) return []
  const tiles: TileRecord[] = []
  for (const entry of value.slice(0, MAX_TILES_PER_WORKSPACE)) {
    const record = asRecord(entry)
    const id = asString(record?.id)
    const url = asString(record?.url)
    const world = asRecord(record?.world)
    if (!id || !url || !world) continue
    if (!TILE_ID_RE.test(id) || !isNavigableUrl(url)) continue
    const x = asNumber(world.x)
    const y = asNumber(world.y)
    const width = asNumber(world.width)
    const height = asNumber(world.height)
    if (x === null || y === null || width === null || height === null) continue
    const tile: TileRecord = {
      id,
      url,
      title: asString(record?.title) ?? '',
      world: { x, y, width: Math.max(64, width), height: Math.max(48, height) },
    }
    // A container is a storage key, so only a well-formed one is kept and the
    // default is left implicit — a file that never mentions partitions stays
    // byte-identical to what it was before they existed.
    const partition = asString(record?.partition)
    if (partition && partition !== DEFAULT_TILE_PARTITION && isTilePartition(partition)) tile.partition = partition
    // Dark mode is one boolean the file may or may not carry. Only a literal `true` is
    // kept — a hand-edited `"yes"` is not a state the app can honour — and absent means
    // off, so a workspace nobody darkened keeps the file shape it had before this.
    if (record?.darkMode === true) tile.darkMode = true
    tiles.push(tile)
  }
  return tiles
}

function coerceState(value: unknown, fallbackName: string): WorkspaceState | null {
  const record = asRecord(value)
  if (!record) return null
  const name = asString(record.name)
  const state: WorkspaceState = {
    version: 1,
    name: name && isValidWorkspaceName(name) ? name : fallbackName,
    savedAt: asString(record.savedAt) ?? new Date().toISOString(),
    viewport: coerceViewport(record.viewport),
    tiles: coerceTiles(record.tiles),
  }
  const frames = coerceFrames(record.frames)
  // Kept absent when empty, so a workspace written before frames existed loads
  // and saves back byte-identically apart from `savedAt`.
  if (frames.length > 0) state.frames = frames
  // Painting order. The validator lives in shared/layers.ts and answers undefined
  // for "this is creation order" — the one case that leaves the key out.
  const stack = coerceStack(record.stack, state.tiles)
  if (stack) state.stack = stack
  // `coerceTheme` answers undefined for "the default", which is exactly the case
  // that leaves the key out of the file. A hand-edited theme is repaired field by
  // field on the way, so a half-written one cannot paint something nobody chose.
  const theme = coerceTheme(record.theme)
  if (theme) state.theme = theme
  return state
}

const FRAME_NAME_MAX = 64

/**
 * Frames are untrusted like tiles: unknown ids are dropped rather than repaired
 * (a repaired id would address nothing), names are trimmed and bounded, and the
 * size is floored at the minimum a usable header needs.
 */
function coerceFrames(value: unknown): FrameRecord[] {
  if (!Array.isArray(value)) return []
  const frames: FrameRecord[] = []
  for (const entry of value.slice(0, MAX_FRAMES_PER_WORKSPACE)) {
    const record = asRecord(entry)
    const id = asString(record?.id)
    if (!id || !TILE_ID_RE.test(id) || frames.some((frame) => frame.id === id)) continue
    const worldX = asNumber(record?.worldX)
    const worldY = asNumber(record?.worldY)
    const worldW = asNumber(record?.worldW)
    const worldH = asNumber(record?.worldH)
    if (worldX === null || worldY === null || worldW === null || worldH === null) continue
    const name = (asString(record?.name) ?? '').trim().slice(0, FRAME_NAME_MAX)
    const frame: FrameRecord = {
      id,
      name: name || 'Frame',
      worldX: Math.round(worldX),
      worldY: Math.round(worldY),
      worldW: Math.max(MIN_FRAME_WORLD_W, Math.round(worldW)),
      worldH: Math.max(MIN_FRAME_WORLD_H, Math.round(worldH)),
    }
    // The one rule for what a colour may be lives in `shared/frame-color.ts`, so
    // the loader cannot accept a tint the swatch row could not have produced.
    const color = asString(record?.color)
    if (isFrameColor(color)) frame.color = color.toLowerCase()
    frames.push(frame)
  }
  return frames
}

/**
 * Layer order, against the tiles that survived loading. The validator is shared
 * with the canvas (`shared/layers.ts`) so the file, the renderer and the sidebar
 * cannot disagree about what a valid order is; here it is only the tile list that
 * supplies the ids, and `undefined` means "creation order", i.e. no key on disk.
 */
function coerceStack(value: unknown, tiles: TileRecord[]): string[] | undefined {
  return normalizeLayerOrder(
    value,
    tiles.map((tile) => tile.id),
  )
}

/**
 * Flat JSON per workspace under `~/.config/waypoint/workspaces/` (or the config root the
 * environment names; see `config-root.ts`).
 * Writes go through a temp file + rename so a crash mid-save cannot truncate
 * an existing workspace.
 */
export class WorkspaceStore {
  private readonly dir: string
  private readonly sessionFile: string
  /**
   * The config root this store owns. Kept so other per-app output (the clip directory)
   * can hang off the same root instead of re-deriving the default in a second place.
   */
  readonly root: string

  constructor(root = resolveConfigRoot()) {
    this.root = root
    this.dir = join(root, 'workspaces')
    this.sessionFile = join(root, 'session.json')
  }

  get directory(): string {
    return this.dir
  }

  pathFor(name: string): string {
    return join(this.dir, `${name}.json`)
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -'.json'.length))
        .filter(isValidWorkspaceName)
        .sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  }

  async save(name: string, snapshot: CanvasSnapshot): Promise<ActionResult> {
    if (!isValidWorkspaceName(name)) {
      return { ok: false, error: 'workspace name must match [a-z0-9._-], start with a letter or digit, and contain no ".."' }
    }
    const state: WorkspaceState = {
      version: 1,
      name,
      savedAt: new Date().toISOString(),
      viewport: coerceViewport(snapshot.viewport),
      tiles: coerceTiles(snapshot.tiles),
    }
    const frames = coerceFrames(snapshot.frames)
    // Written only when the workspace has frames: a canvas without zones keeps
    // the exact file shape it had before frames existed.
    if (frames.length > 0) state.frames = frames
    const stack = coerceStack(snapshot.stack, state.tiles)
    // Same rule for the layer order: a workspace nobody re-ordered writes no key.
    if (stack) state.stack = stack
    // The default theme is the absence of a theme, so an untouched workspace does
    // not grow seven fields on its next save.
    const theme = coerceTheme(snapshot.theme)
    if (theme) state.theme = theme
    try {
      await mkdir(this.dir, { recursive: true })
      const target = this.pathFor(name)
      const tmp = `${target}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(tmp, target)
      return { ok: true, name }
    } catch (error) {
      return { ok: false, error: `save failed: ${String(error)}` }
    }
  }

  async load(name: string): Promise<WorkspaceState | null> {
    if (!isValidWorkspaceName(name)) return null
    try {
      const raw = await readFile(this.pathFor(name), 'utf8')
      if (raw.length > MAX_FILE_BYTES) return null
      return coerceState(JSON.parse(raw), name)
    } catch {
      return null
    }
  }

  async remove(name: string): Promise<boolean> {
    if (!isValidWorkspaceName(name)) return false
    try {
      await rm(this.pathFor(name), { force: true })
      return true
    } catch {
      return false
    }
  }

  async exists(name: string): Promise<boolean> {
    if (!isValidWorkspaceName(name)) return false
    try {
      await access(this.pathFor(name))
      return true
    } catch {
      return false
    }
  }

  /**
   * Rename is a copy-then-unlink, in that order: the atomic save under the new
   * name lands first, so a crash in between leaves two copies of the workspace
   * instead of none. The name is validated on both sides, which is what keeps a
   * rename from becoming an arbitrary filesystem move.
   */
  async rename(from: string, to: string): Promise<ActionResult> {
    if (!isValidWorkspaceName(from) || !isValidWorkspaceName(to)) {
      return { ok: false, error: 'workspace name must match [a-z0-9._-], start with a letter or digit, and contain no ".."' }
    }
    if (from === to) return { ok: true, name: to }
    const state = await this.load(from)
    if (!state) return { ok: false, error: `workspace "${from}" not found` }
    if (await this.exists(to)) return { ok: false, error: `workspace "${to}" already exists` }
    const written = await this.save(to, {
      viewport: state.viewport,
      tiles: state.tiles,
      frames: state.frames,
      // A rename is not a reset: the order travels with the tiles, for the same
      // reason the theme does — a renamed copy that reshuffled its layers would be
      // a different workspace with the same name.
      stack: state.stack,
      // A rename is not a reset: carrying the theme is the whole reason this
      // rebuilds the snapshot from the loaded state rather than from the canvas.
      theme: state.theme,
    })
    if (!written.ok) return written
    await this.remove(from)
    return { ok: true, name: to }
  }

  /** Clone to `<name>-copy`, `<name>-copy-2`, … — a fresh file, never a link. */
  async duplicate(name: string): Promise<ActionResult> {
    if (!isValidWorkspaceName(name)) return { ok: false, error: 'invalid workspace name' }
    const state = await this.load(name)
    if (!state) return { ok: false, error: `workspace "${name}" not found` }
    const taken = new Set(await this.list())
    const base = `${name}-copy`
    let target = base
    for (let index = 2; taken.has(target); index += 1) target = `${base}-${index}`
    const written = await this.save(target, {
      viewport: state.viewport,
      tiles: state.tiles,
      frames: state.frames,
      // A copy that loses its layer order (or its theme) is not a copy.
      stack: state.stack,
      // A copy that loses its theme is not a copy.
      theme: state.theme,
    })
    if (!written.ok) return written
    return { ok: true, name: target }
  }

  async session(): Promise<SessionInfo> {
    const workspaces = await this.list()
    let last: string | null = null
    let cosmeticPaused: string[] = []
    let windowBounds: Rect | undefined
    let windowMaximized = false
    try {
      const parsed = JSON.parse(await readFile(this.sessionFile, 'utf8')) as unknown
      const record = asRecord(parsed)
      const candidate = asString(record?.lastWorkspace)
      if (candidate && workspaces.includes(candidate)) last = candidate
      const paused = record?.cosmeticPaused
      if (Array.isArray(paused)) {
        cosmeticPaused = paused
          .filter((host): host is string => typeof host === 'string' && host.length > 0)
          .slice(0, MAX_PAUSED_HOSTS_PERSISTED)
      }
      // Written only while there is geometry to write, so a session file from before
      // the window was remembered still reads as "nothing to restore" rather than as
      // a rect of zeros.
      windowBounds = coerceWindowBounds(record?.windowBounds)
      windowMaximized = record?.windowMaximized === true
    } catch {
      // No session file yet: first run.
    }
    const info: SessionInfo = { lastWorkspace: last, workspaces, cosmeticPaused }
    if (windowBounds) {
      info.windowBounds = windowBounds
      info.windowMaximized = windowMaximized
    }
    return info
  }

  /**
   * Merge the cosmetic pause list into `session.json` rather than rewriting it:
   * `rememberLast` owns `lastWorkspace` in the same file, and turning a site's rules
   * off must not forget which workspace was open.
   */
  async persistCosmeticPaused(hosts: string[]): Promise<void> {
    await this.mergeSession({ cosmeticPaused: hosts.slice(0, MAX_PAUSED_HOSTS_PERSISTED) })
  }

  /**
   * Both writers go through one merge, because the opposite hole is the same bug: a
   * `lastWorkspace` write must not drop the pause list any more than the pause list
   * may drop `lastWorkspace`.
   */
  private async mergeSession(patch: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(dirname(this.sessionFile), { recursive: true })
      let existing: Record<string, unknown> = {}
      try {
        const record = asRecord(JSON.parse(await readFile(this.sessionFile, 'utf8')))
        if (record) existing = { ...record }
      } catch {
        // No session file yet; the write below creates one.
      }
      await writeFile(this.sessionFile, JSON.stringify({ ...existing, ...patch }, null, 2), 'utf8')
    } catch {
      // Session memory is a convenience; failing to write it must not break the app.
    }
  }

  async rememberLast(name: string | null): Promise<void> {
    // Merged, not rewritten: this file also holds the cosmetic pause list, and a
    // workspace switch must not silently re-enable every site the user paused.
    await this.mergeSession({ lastWorkspace: name })
  }

  /**
   * Remember where the window was. Merged like everything else in this file, so
   * quitting cannot forget the workspace or the pause list on its way out.
   */
  async rememberWindow(bounds: Rect, maximized: boolean): Promise<void> {
    await this.mergeSession({ windowBounds: coerceWindowBounds(bounds) ?? null, windowMaximized: maximized })
  }
}

/**
 * The window's geometry, read synchronously.
 *
 * The shell has to be created at the remembered size, and that is before any `await`
 * in the process — `app.whenReady()` runs a promise callback, but `new BaseWindow`
 * cannot wait for one. So this is the synchronous face of `session()` for the two
 * fields that are needed that early. It reads the same file through the same
 * coercion, and answers `maximized: true` when there is nothing to restore, which is
 * the behaviour every launch had before geometry was remembered.
 */
export function readWindowState(root: string): { bounds: Rect | null; maximized: boolean } {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'session.json'), 'utf8')) as unknown
    const record = asRecord(raw)
    const bounds = coerceWindowBounds(record?.windowBounds) ?? null
    // No geometry on record: maximize, exactly as a fresh install always did.
    if (!bounds) return { bounds: null, maximized: true }
    return { bounds, maximized: record?.windowMaximized === true }
  } catch {
    return { bounds: null, maximized: true }
  }
}
