import { app, clipboard, Menu, session, webContents } from 'electron'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { BaseWindow, Cookie, WebContentsView } from 'electron'
import { CASCADE_STEP_WORLD, DOCK_HEIGHT, DOCK_WIDTH, FIT_MAX_ZOOM, FIT_PADDING, FRAME_PADDING_WORLD, SIDEBAR_RAIL_WIDTH, SIDEBAR_WIDTH } from '../shared/constants.ts'
import { FRAME_COLORS } from '../shared/frame-color.ts'
import { containsPoint, intersects } from '../shared/math.ts'
import { DEFAULT_TILE_PARTITION } from '../shared/session-partition.ts'
import type { CanvasStatus, CanvasTool, OverlayMode, Rect, TileSummary, WorkspaceState } from '../shared/types.ts'
import type { ContextMenuEntry } from '../shared/context-menu.ts'
import type { BookmarkRecord } from '../shared/bookmarks.ts'
import type { TileRegistry } from './registry.ts'
import { flushCookieStores } from './sessions.ts'
import { CONFIG_DIR_ENV, SMOKE_NET_ENV, firstEnv } from './config-root.ts'
import { BookmarkFile } from './bookmarks.ts'
import type { BlockerStats } from './adblock.ts'
import type { CosmeticStats } from './cosmetic.ts'
import { WorkspaceStore } from './workspaces.ts'

export interface SmokeHost {
  canvas: WebContentsView
  overlay: WebContentsView
  dock: WebContentsView
  sidebar: WebContentsView
  /**
   * The window itself. `getFocusedWebContents()` is per-app, so it reports a focused view even
   * while another application is frontmost — and a paste is dropped in that state. A check that
   * needs the edit commands to land has to see this flag as well.
   */
  window: BaseWindow
  registry: TileRegistry
  store: WorkspaceStore
  mode: () => OverlayMode
  overlayBounds: () => Rect
  dockBounds: () => Rect
  sidebarBounds: () => Rect
  status: () => CanvasStatus
  tool: () => CanvasTool
  inventory: () => TileSummary[]
  /** The inventory as the chrome receives it, cosmetic state included. */
  chromeTiles: () => TileSummary[]
  blocker: () => BlockerStats
  /** Cosmetic rule-set size and pause count, as main holds it. */
  cosmetic: () => CosmeticStats
  /**
   * The tile views in the order the window really paints them, back to front, read
   * from the live child list. Independent of the canvas DOM and of the pushed
   * inventory, so a check can compare the two layers instead of trusting one.
   */
  viewOrder: () => string[]
  /**
   * Whether main has this tile's dark stylesheet inserted right now — the state the
   * document reached, not the flag the canvas asked for. `null` once the tile is gone.
   */
  darkOf: (id: string) => boolean | null
  /** The directory clips land in, so a check can read the note that was written. */
  clipDir: () => string
  /** The entries the last right-click produced in any view; empty when it offered nothing. */
  contextMenu: () => ContextMenuEntry[]
  /**
   * The Menu built from those entries. A check invokes a real item's own click handler
   * through it — the entries say what was offered, this says it is wired to something.
   */
  contextMenuMenu: () => Menu | null
  /** The bookmark file as main holds it, newest first. */
  bookmarks: () => BookmarkRecord[]
  /** Where that file lives, so a check can read what was actually written. */
  bookmarkPath: () => string
  /**
   * The last workspace main wrote on its own: the debounced autosave, as opposed to an
   * explicit ⌘S. `null` until one has landed.
   */
  lastAutosave: () => { name: string; tiles: number; at: number } | null
  /**
   * The save the quit and close paths run, callable from a check. The run cannot quit
   * mid-suite, so this is what makes "the last move is on disk before the window goes"
   * an assertion instead of a claim.
   */
  flushActive: () => Promise<void>
  /** The geometry save the quit paths run, once, so a check can read it back. */
  rememberWindow: () => Promise<void>
}

interface Measurements {
  tiles: number
  tile: { x: number; y: number; width: number; height: number; chrome: number } | null
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await wait(50)
  }
  return predicate()
}

/**
 * End-to-end check used by `npm run smoke`. Drives the real renderer through
 * the real bridge: keyboard palette, tile creation, coordinate alignment
 * between DOM and WebContentsView, and a workspace save/load round trip.
 * Exits 0 only when every step passes.
 */
export async function runSmoke(host: SmokeHost): Promise<number> {
  const failures: string[] = []
  const lines: string[] = []

  const check = (name: string, ok: boolean, detail = ''): void => {
    lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
    if (!ok) failures.push(name)
  }

  const evaluate = <T>(view: WebContentsView, code: string): Promise<T> =>
    view.webContents.executeJavaScript(code, true) as Promise<T>

  /** DOM renders land asynchronously after an IPC round trip; poll instead of racing. */
  const waitForEval = async (view: WebContentsView, code: string, timeoutMs = 3000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(view, code)) return true
      await wait(50)
    }
    return false
  }

  const measure = (): Promise<Measurements> =>
    evaluate<Measurements>(
      host.canvas,
      `(() => {
        const tiles = [...document.querySelectorAll('.tile')]
        const first = tiles[0]
        if (!first) return { tiles: 0, tile: null }
        const rect = first.getBoundingClientRect()
        const chrome = first.querySelector('.tile-chrome').getBoundingClientRect()
        return {
          tiles: tiles.length,
          tile: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), chrome: Math.round(chrome.height) },
        }
      })()`,
    )

  try {
    // 1. Both pages loaded their preload bridge (catches CSP or preload errors).
    const canvasBridge = await evaluate<boolean>(
      host.canvas,
      `typeof window.canvasBridge === 'object' && typeof window.canvasBridge.createTile === 'function'`,
    )
    check('canvas preload bridge exposed', canvasBridge === true)

    const overlayBridge = await evaluate<boolean>(
      host.overlay,
      `typeof window.overlayBridge === 'object' && typeof window.overlayBridge.action === 'function'`,
    )
    check('overlay preload bridge exposed', overlayBridge === true)

    // The suite creates workspaces, bookmarks, clips and session state, so where it writes is a
    // correctness property, not a convenience: `--smoke` isolates nothing by itself. This turns the
    // packaging skill's rule into a red check — an unqualified `<App> --smoke` now fails here on the
    // first assertion instead of quietly rewriting the user's real profile.
    const namedRoot = firstEnv(process.env, CONFIG_DIR_ENV)
    check(
      'the smoke suite runs against the config root it was given',
      namedRoot !== undefined && host.store.root === namedRoot,
      `root=${host.store.root} env=${namedRoot ?? '(unset)'}`,
    )

    // 2. Compact HUD renders and asks main for config.
    const hud = await waitForEval(host.overlay, `!!document.querySelector('[data-role="hud"]')`)
    check('compact HUD rendered', hud === true)

    // 3. Keyboard 'n' raises the omnibox and expands the overlay view.
    await evaluate<void>(
      host.canvas,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })), undefined`,
    )
    check('N opens the omnibox', await waitFor(() => host.mode() === 'omnibox'))
    const expanded = host.overlayBounds()
    const windowBounds = host.canvas.getBounds()
    check(
      'overlay expands to the window',
      expanded.x === 0 && expanded.y === 0 && expanded.width === windowBounds.width && expanded.height === windowBounds.height,
      `overlay=${expanded.width}x${expanded.height} window=${windowBounds.width}x${windowBounds.height}`,
    )

    const omnibox = await waitForEval(host.overlay, `!!document.querySelector('[data-role="omnibox"]')`)
    check('omnibox input rendered', omnibox === true)

    // 4. Creating from the omnibox spawns a real WebContentsView.
    const created = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'create', input: 'about:blank' })`,
    )
    check('overlay create action ok', created.ok === true, created.error ?? '')
    check('tile view registered', await waitFor(() => host.registry.size === 1), `tiles=${host.registry.size}`)
    check('overlay collapses after create', await waitFor(() => host.mode() === 'compact', 5000))

    // The tile's DOM box only exists once the canvas's rAF pipeline has laid it out; before that
    // the element measures at its pre-layout size. A fixed wait makes the alignment check
    // timing-dependent — measured 2026-11-02, one run read the tile at 289x35 (`dom=0,0+289x35
    // view=2980,622+760x508`) and reported a red that named the wrong feature. Wait for the layout
    // to land, then compare the same numbers as before.
    const laidOut = await waitForEval(
      host.canvas,
      `(() => {
         const el = document.querySelector('.tile')
         if (!el) return false
         const rect = el.getBoundingClientRect()
         return rect.width > 100 && rect.height > 100
       })()`,
      5000,
    )
    check('tile DOM laid out', laidOut === true)
    const first = await measure()
    check('tile DOM rendered', first.tiles === 1, `dom tiles=${first.tiles}`)

    const tileId = host.registry.ids[0]
    const viewBounds = tileId ? host.registry.boundsOf(tileId) : null
    check('view bounds reported', viewBounds !== null)
    if (first.tile && viewBounds) {
      const dom = first.tile
      const aligned =
        Math.abs(dom.y + dom.chrome - viewBounds.y) <= 2 &&
        Math.abs(dom.x - viewBounds.x) <= 2 &&
        Math.abs(dom.width - viewBounds.width) <= 2 &&
        Math.abs(dom.height - dom.chrome - viewBounds.height) <= 2
      check(
        'DOM chrome and view bounds agree',
        aligned,
        `dom=${dom.x},${dom.y}+${dom.width}x${dom.height} chrome=${dom.chrome} view=${viewBounds.x},${viewBounds.y}+${viewBounds.width}x${viewBounds.height}`,
      )
    }

    // 5. Zoom keeps DOM and view in lockstep (proves the rAF pipeline).
    const zoomBefore = host.status().zoom
    await evaluate<void>(
      host.canvas,
      `document.getElementById('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true })), undefined`,
    )
    check('wheel zooms out', await waitFor(() => host.status().zoom < zoomBefore), `before=${zoomBefore} after=${host.status().zoom}`)
    await wait(250)
    const zoomed = await measure()
    const zoomedBounds = tileId ? host.registry.boundsOf(tileId) : null
    if (zoomed.tile && zoomedBounds) {
      check(
        'bounds stay aligned while zoomed',
        Math.abs(zoomed.tile.y + zoomed.tile.chrome - zoomedBounds.y) <= 2 &&
          Math.abs(zoomed.tile.width - zoomedBounds.width) <= 2,
        `dom=${zoomed.tile.width}w view=${zoomedBounds.width}w`,
      )
    }

    // 6. Workspace save writes flat JSON and sanitizes the name.
    const saved = await evaluate<{ ok: boolean; error?: string; name?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'save', name: 'Smoke Test' })`,
    )
    check('workspace save ok', saved.ok === true, saved.error ?? '')
    check('workspace name sanitized', saved.name === 'smoke-test', `name=${String(saved.name)}`)

    const listed = await host.store.list()
    check('workspace listed on disk', listed.includes('smoke-test'), listed.join(','))
    const loaded: WorkspaceState | null = await host.store.load('smoke-test')
    check('workspace reloads', loaded !== null && loaded.tiles.length === 1, `tiles=${loaded?.tiles.length ?? -1}`)
    check('workspace keeps zoom', loaded !== null && Math.abs(loaded.viewport.zoom - host.status().zoom) < 0.01, `zoom=${loaded?.viewport.zoom ?? -1}`)
    check('tile url persisted', loaded?.tiles[0]?.url === 'about:blank', String(loaded?.tiles[0]?.url))
    check(
      'default tiles write no partition field',
      loaded?.tiles[0] !== undefined && !('partition' in loaded.tiles[0]),
      JSON.stringify(loaded?.tiles[0] ?? null),
    )

    // 7. Switching workspaces rebuilds the canvas.
    const switched = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'switch', name: 'smoke-test' })`,
    )
    check('workspace switch ok', switched.ok === true, switched.error ?? '')
    check('canvas rebuilt from disk', await waitFor(() => host.registry.size === 1), `tiles=${host.registry.size}`)
    await wait(150)
    const rebuilt = await measure()
    check('rebuilt tile DOM', rebuilt.tiles === 1, `dom tiles=${rebuilt.tiles}`)

    // 8. A real page load flows back through the runtime channel into the chrome.
    // The body is percent-encoded: raw "<" and ">" are not valid in a URL and
    // Chromium rejects the load instead of rendering it.
    const page = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'create', input: 'data:text/html,%3Ctitle%3ERuntime%20Check%3C/title%3E%3Ch1%3Ehi%3C/h1%3E' })`,
    )
    check('second tile created', page.ok === true, page.error ?? '')
    await wait(500)
    const labels = await evaluate<string[]>(
      host.canvas,
      `[...document.querySelectorAll('.tile-label')].map((el) => el.textContent ?? '')`,
    )
    check('page title reaches the tile chrome', labels.includes('Runtime Check'), JSON.stringify(labels))

    // 8b. Tile chrome is canvas DOM and every tile's WebContentsView paints over
    //     it. A tile spawned on top of another one therefore has a title bar that
    //     nothing can click: the trapped-window bug. Placement must refuse to
    //     overlap, and the invariant is asserted against the native view rects —
    //     the view is what covers chrome, not the DOM box.
    interface PlacedTile {
      id: string
      box: Rect
      chrome: Rect
    }
    const placed = await evaluate<PlacedTile[]>(
      host.canvas,
      `(() => {
        const box = (node) => {
          const rect = node.getBoundingClientRect()
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        }
        return [...document.querySelectorAll('.tile')].map((el) => ({
          id: el.dataset.tileId,
          box: box(el),
          chrome: box(el.querySelector('.tile-chrome')),
        }))
      })()`,
    )
    check('both tiles measured for layering', placed.length === 2, `dom tiles=${placed.length}`)

    const stacked = placed.flatMap((a) =>
      placed.filter((b) => b.id !== a.id && intersects(a.box, b.box)).map((b) => `${a.id}~${b.id}`),
    )
    check('new tile does not land on the existing tile', stacked.length === 0, stacked.join(','))

    const buried = placed.flatMap((a) => {
      const under = placed
        .filter((b) => b.id !== a.id)
        .filter((b) => {
          const view = host.registry.boundsOf(b.id)
          return view !== null && intersects(a.chrome, view)
        })
        .map((b) => `${a.id} chrome under ${b.id}`)
      return under
    })
    check('no title bar is covered by another tile page', buried.length === 0, buried.join(','))

    // 8c. The new tile's title bar is the drag handle, so it must move that tile
    //     and only that tile. Deltas are screen px and the drag path divides by
    //     zoom, so the expectation is zoom-independent. Layout runs in the
    //     canvas's rAF pipeline, so a drag is only measured a frame later.
    const older = placed[0]
    const newer = placed[1]
    if (!older || !newer) throw new Error('layering checks need exactly two tiles')

    const measureTiles = (): Promise<PlacedTile[]> =>
      evaluate<PlacedTile[]>(
        host.canvas,
        `(() => {
          const box = (node) => {
            const rect = node.getBoundingClientRect()
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          }
          return [...document.querySelectorAll('.tile')].map((el) => ({
            id: el.dataset.tileId,
            box: box(el),
            chrome: box(el.querySelector('.tile-chrome')),
          }))
        })()`,
      )

    /** Press the title bar, drag by a screen delta, release, wait for layout. */
    const dragBy = async (id: string, dx: number, dy: number): Promise<boolean> => {
      const pressed = await evaluate<boolean>(
        host.canvas,
        `(() => {
          const self = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(id)})
          if (!self) return false
          const chrome = self.querySelector('.tile-chrome')
          const bar = chrome.getBoundingClientRect()
          const x = bar.x + 60
          const y = bar.y + Math.min(bar.height, 20) / 2
          chrome.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 41, clientX: x, clientY: y }))
          for (const step of [0.25, 0.5, 0.75, 1]) {
            self.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 41, clientX: x + ${dx} * step, clientY: y + ${dy} * step }))
          }
          self.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 41, clientX: x + ${dx}, clientY: y + ${dy} }))
          return true
        })()`,
      )
      await wait(150)
      return pressed
    }

    check('title bar press reaches the new tile', (await dragBy(newer.id, 80, 60)) === true)
    const afterDrag = await measureTiles()
    const newMoved = afterDrag.find((tile) => tile.id === newer.id)?.box ?? newer.box
    const oldHeld = afterDrag.find((tile) => tile.id === older.id)?.box ?? older.box
    check(
      'title bar drag moves the new tile',
      Math.abs(newMoved.x - newer.box.x - 80) <= 3 && Math.abs(newMoved.y - newer.box.y - 60) <= 3,
      `moved ${Math.round(newMoved.x - newer.box.x)},${Math.round(newMoved.y - newer.box.y)}`,
    )
    check(
      'title bar drag leaves the tile beneath untouched',
      oldHeld.x === older.box.x && oldHeld.y === older.box.y,
      `moved ${Math.round(oldHeld.x - older.box.x)},${Math.round(oldHeld.y - older.box.y)}`,
    )
    check(
      'tile view follows its title bar drag',
      await waitFor(() => {
        const view = host.registry.boundsOf(newer.id)
        return view !== null && Math.abs(view.x - newMoved.x) <= 3 && Math.abs(view.width - newMoved.width) <= 3
      }),
      `view=${JSON.stringify(host.registry.boundsOf(newer.id))} dom=${Math.round(newMoved.x)}`,
    )

    // 8d. Force the stack this task is about: drag the new tile back over the old
    //     one, then check the top tile's title bar still drives it and the tile
    //     underneath holds still. The press point sits inside the lower tile's
    //     page — the exact coordinate that used to be dead, because chrome under
    //     another view never receives a click.
    // Aim the top tile's left edge 60px inside the lower tile and 40px down, so
    // its chrome ends up squarely over the other tile's page.
    const beforeStack = afterDrag.find((tile) => tile.id === newer.id) ?? newer
    const lower = afterDrag.find((tile) => tile.id === older.id) ?? older
    const toOverlapX = Math.round(lower.box.x + 60 - beforeStack.box.x)
    const toOverlapY = Math.round(lower.box.y + 40 - beforeStack.box.y)
    await dragBy(newer.id, toOverlapX, toOverlapY)
    const stackedNow = await measureTiles()
    const top = stackedNow.find((tile) => tile.id === newer.id) ?? beforeStack
    const under = stackedNow.find((tile) => tile.id === older.id) ?? lower
    const overlapW = Math.min(top.box.x + top.box.width, under.box.x + under.box.width) - Math.max(top.box.x, under.box.x)
    const overlapH = Math.min(top.box.y + top.box.height, under.box.y + under.box.height) - Math.max(top.box.y, under.box.y)
    check(
      'tiles can be dragged into an overlap',
      overlapW > 40 && overlapH > 40,
      `overlap=${Math.round(overlapW)}x${Math.round(overlapH)}px`,
    )
    const grabX = top.chrome.x + 60
    const grabY = top.chrome.y + 5
    check(
      'the overlapped title bar sits over the lower tile page',
      grabX > under.box.x &&
        grabX < under.box.x + under.box.width &&
        grabY > under.box.y &&
        grabY < under.box.y + under.box.height,
      `grab=${Math.round(grabX)},${Math.round(grabY)} under=${JSON.stringify(under.box)}`,
    )

    await dragBy(newer.id, 40, 30)
    const afterStack = await measureTiles()
    const topAfter = afterStack.find((tile) => tile.id === newer.id)?.box ?? top.box
    const underAfter = afterStack.find((tile) => tile.id === older.id)?.box ?? under.box
    check(
      'overlapped tile still answers its title bar',
      Math.abs(topAfter.x - top.box.x - 40) <= 3 && Math.abs(topAfter.y - top.box.y - 30) <= 3,
      `moved ${Math.round(topAfter.x - top.box.x)},${Math.round(topAfter.y - top.box.y)}`,
    )
    check(
      'overlapped tile drag leaves the tile beneath untouched',
      underAfter.x === under.box.x && underAfter.y === under.box.y,
      `moved ${Math.round(underAfter.x - under.box.x)},${Math.round(underAfter.y - under.box.y)}`,
    )

    // Leave the canvas unstacked for the checks that follow.
    await dragBy(newer.id, -toOverlapX, -toOverlapY)

    // Optional live-network probe: WAYPOINT_SMOKE_NET=1 npm run smoke
    if (firstEnv(process.env, SMOKE_NET_ENV) === '1') {
      const net = await evaluate<{ ok: boolean; error?: string }>(
        host.overlay,
        `window.overlayBridge.action({ kind: 'create', input: 'https://example.com' })`,
      )
      check('network tile created', net.ok === true, net.error ?? '')
      const live = await waitForEval(
        host.canvas,
        `[...document.querySelectorAll('.tile-label')].some((el) => (el.textContent ?? '').includes('Example'))`,
        20000,
      )
      check('network page loads and titles', live === true)
    }

    // 9. Path traversal in a workspace name is refused, not written.
    const rejected = await evaluate<{ ok: boolean }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'switch', name: '../../../etc/passwd' })`,
    )
    check('unsafe workspace name rejected', rejected.ok === false)

    // 10. window.open() is denied as a window and dispatched as a new tile on the
    //     next tick. Creating the view inside Chromium's synchronous window-open
    //     stack is one of the SIGTRAP paths, so the deny must be immediate.
    const popup = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'create', input: 'data:text/html,%3Cscript%3Ewindow.open(%22data:text/html,popup%22)%3C/script%3E' })`,
    )
    check('popup opener tile created', popup.ok === true, popup.error ?? '')
    const forwarded = await waitForEval(
      host.canvas,
      `[...document.querySelectorAll('.tile-label')].some((el) => (el.textContent ?? '').includes('popup'))`,
      10000,
    )
    check('popup denied and forwarded as a tile on the next tick', forwarded === true)

    // 11. A crashed tile renderer is logged, flagged, and does not take the shell
    //     with it — and the bounds pipeline must skip it instead of calling into
    //     a webContents whose frame host is gone.
    const target = webContents.getAllWebContents().find((candidate) => {
      if (candidate.isDestroyed()) return false
      let url = ''
      try {
        url = decodeURIComponent(candidate.getURL())
      } catch {
        url = candidate.getURL()
      }
      return url.includes('<title>Runtime Check</title>')
    })
    check('found the tile webContents to crash', Boolean(target))
    target?.forcefullyCrashRenderer()

    const flagged = await waitForEval(
      host.canvas,
      `[...document.querySelectorAll('.tile.failed .tile-error')].some((el) => (el.textContent ?? '').includes('renderer'))`,
      8000,
    )
    check('crashed renderer flagged with its reason', flagged === true)

    const crashedId = await evaluate<string | null>(
      host.canvas,
      `document.querySelector('.tile.failed')?.dataset.tileId ?? null`,
    )
    check('crashed tile is skipped by bounds reconciliation', crashedId !== null && host.registry.boundsOf(crashedId) === null)

    const zoomBeforeCrashPass = host.status().zoom
    await evaluate<void>(
      host.canvas,
      `document.getElementById('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })), undefined`,
    )
    const shellAlive = await waitFor(() => host.status().zoom !== zoomBeforeCrashPass, 3000)
    const stillAnswers = await evaluate<number>(host.canvas, '1 + 1')
    check(
      'shell survives a bounds pass over a crashed tile',
      shellAlive && stillAnswers === 2 && !host.canvas.webContents.isDestroyed(),
      `zoom ${zoomBeforeCrashPass}->${host.status().zoom}`,
    )

    const reloadClicked = await evaluate<boolean>(
      host.canvas,
      `(() => {
        const button = document.querySelector('.tile.failed [data-role="reload"]')
        if (!(button instanceof HTMLElement)) return false
        button.click()
        return true
      })()`,
    )
    check('reload is offered for a crashed tile', reloadClicked === true)
    const recovered = await waitForEval(
      host.canvas,
      `[...document.querySelectorAll('.tile')].some((el) => !el.classList.contains('failed') && [...el.querySelectorAll('.tile-label')].some((label) => (label.textContent ?? '').includes('Runtime Check')))`,
      10000,
    )
    check('reload restarts the crashed renderer', recovered === true)

    // 12. The dock and the sidebar are separate views with separate preloads.
    const dockBridge = await evaluate<boolean>(
      host.dock,
      `typeof window.overlayBridge === 'object' && window.overlayBridge.region === 'dock'`,
    )
    check('dock view runs as its own region', dockBridge === true)
    const sidebarBridge = await evaluate<boolean>(
      host.sidebar,
      `typeof window.overlayBridge === 'object' && window.overlayBridge.region === 'sidebar'`,
    )
    check('sidebar view runs as its own region', sidebarBridge === true)

    const dockRendered = await waitForEval(
      host.dock,
      `!!document.querySelector('[data-role="omnibox"]') && !!document.querySelector('[data-role="zoom"]')`,
    )
    check('dock renders omnibox and zoom pill', dockRendered === true)

    // 13. The chrome views are exactly as large as the panels they draw — never
    //     the whole window — or they would swallow clicks meant for the tiles.
    const windowRect = host.canvas.getBounds()
    const dockRect = host.dockBounds()
    check(
      'dock view is a strip, not the window',
      dockRect.width === DOCK_WIDTH && dockRect.height === DOCK_HEIGHT && dockRect.y > windowRect.height / 2,
      `dock=${dockRect.x},${dockRect.y} ${dockRect.width}x${dockRect.height}`,
    )
    const sideRect = host.sidebarBounds()
    check(
      'sidebar view is a column, not the window',
      sideRect.width === SIDEBAR_WIDTH && sideRect.height === windowRect.height,
      `sidebar=${sideRect.width}x${sideRect.height}`,
    )

    // 14. The sidebar lists what the canvas owns.
    const rows = await waitForEval(
      host.sidebar,
      `document.querySelectorAll('[data-tile-id]').length === ${host.inventory().length} && document.querySelectorAll('[data-tile-id]').length > 0`,
      4000,
    )
    check('sidebar lists every open tile', rows === true, `rows vs inventory=${host.inventory().length}`)

    // 15. Selecting a tile in the canvas marks it in the sidebar.
    const selectedInCanvas = await evaluate<boolean>(
      host.canvas,
      `(() => {
        const tile = document.querySelector('.tile:not(.failed)')
        if (!tile) return false
        tile.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        return tile.classList.contains('tile-selected')
      })()`,
    )
    check('clicking a tile selects it', selectedInCanvas === true)
    const selectedId = await evaluate<string | null>(
      host.canvas,
      `document.querySelector('.tile-selected')?.dataset.tileId ?? null`,
    )
    const rowSelected = await waitForEval(
      host.sidebar,
      `document.querySelector('.tile-row.selected')?.dataset.tileId === ${JSON.stringify(selectedId)}`,
      4000,
    )
    check('sidebar follows the canvas selection', rowSelected === true, String(selectedId))

    // 16. Corner grips exist only for the selected tile.
    const grips = await evaluate<number>(
      host.canvas,
      `document.querySelectorAll('.tile-selected [data-role="corner"]').length`,
    )
    check('selected tile exposes four corner grips', grips === 4, `grips=${grips}`)

    // 17. Clicking a sidebar row centres that tile in the viewport.
    const centred = await evaluate<{ clicked: boolean }>(
      host.sidebar,
      `(() => {
        const row = document.querySelector('.tile-row')
        if (!(row instanceof HTMLElement)) return { clicked: false }
        row.click()
        return { clicked: true }
      })()`,
    )
    check('sidebar row click dispatched', centred.clicked === true)
    await wait(400)
    const alignment = await evaluate<{ dx: number; dy: number }>(
      host.canvas,
      `(() => {
        const tile = document.querySelector('.tile-selected')
        if (!tile) return { dx: 9999, dy: 9999 }
        const rect = tile.getBoundingClientRect()
        return {
          dx: Math.round(rect.x + rect.width / 2 - window.innerWidth / 2),
          dy: Math.round(rect.y + rect.height / 2 - window.innerHeight / 2),
        }
      })()`,
    )
    check(
      'sidebar click pans the tile to the viewport centre',
      Math.abs(alignment.dx) <= 2 && Math.abs(alignment.dy) <= 2,
      `offset=${alignment.dx},${alignment.dy}`,
    )

    // 18. Space is a character, not a pan key. The old interceptor armed on a held
    //     spacebar from anywhere — including over a tile's page, whose webContents
    //     owns the keyboard — and put a grab layer over the whole window while the
    //     HUD dimmed under the pointer. Main now reads no key from a page at all, so
    //     both paths have to stay inert.
    host.canvas.webContents.focus()
    host.canvas.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    host.canvas.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await wait(250)
    check('Space on the canvas does not arm the interceptor', host.mode() === 'compact', `mode=${host.mode()}`)

    const spaceTile = host.registry.ids[0]
    const spacePage = spaceTile ? host.registry.contentsOf(spaceTile) : null
    if (spacePage) spacePage.focus()
    await wait(150)
    if (spacePage) {
      spacePage.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
      spacePage.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    }
    await wait(250)
    check(
      'Space over a tile page does not arm the interceptor',
      host.mode() === 'compact',
      `tile=${String(spaceTile)} mode=${host.mode()}`,
    )

    // 18b. The hand tool is the only arm source. Bounds are asserted together with
    //      the live pointer-events value: an interceptor that is inert and one that
    //      is armed cover the same rectangle, so bounds alone prove nothing.
    host.canvas.webContents.focus()
    const latched = await evaluate<{ ok: boolean }>(
      host.dock,
      `window.overlayBridge.action({ kind: 'set-tool', tool: 'pan' })`,
    )
    check('hand tool action accepted', latched.ok === true)
    const armed = await waitFor(() => host.mode() === 'pan', 2000)
    check('hand tool arms the pan interceptor', armed === true, `mode=${host.mode()}`)
    const panBounds = host.overlayBounds()
    check(
      'armed interceptor covers the window',
      panBounds.x === 0 && panBounds.y === 0 && panBounds.width === windowRect.width && panBounds.height === windowRect.height,
      `overlay=${panBounds.width}x${panBounds.height}`,
    )
    // The state machine says "armed"; this says the layer the user actually
    // clicks is the one taking the pointer.
    const interceptor = (): Promise<{ pointer: string; cursor: string }> =>
      evaluate<{ pointer: string; cursor: string }>(
        host.overlay,
        `(() => {
          const layer = document.getElementById('pan-interceptor')
          if (!layer) return { pointer: 'missing', cursor: 'missing' }
          const style = getComputedStyle(layer)
          return { pointer: style.pointerEvents, cursor: style.cursor }
        })()`,
      )
    const armedStyle = await interceptor()
    check(
      'armed interceptor takes pointer events',
      armedStyle.pointer === 'auto' && armedStyle.cursor === 'grab',
      JSON.stringify(armedStyle),
    )

    // 19. A drag on the interceptor moves the canvas. The grid's background
    //     position is the viewport's pan, so it is the observable for this.
    const panBefore = await evaluate<string>(
      host.canvas,
      `document.getElementById('grid').style.backgroundPosition`,
    )
    const dragged = await evaluate<boolean>(
      host.overlay,
      `(() => {
        const layer = document.getElementById('pan-interceptor')
        if (!layer) return false
        layer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 200, clientY: 200 }))
        layer.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 260, clientY: 230 }))
        layer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 260, clientY: 230 }))
        return true
      })()`,
    )
    check('interceptor drag dispatched', dragged === true)
    const panned = await waitForEval(
      host.canvas,
      `document.getElementById('grid').style.backgroundPosition !== ${JSON.stringify(panBefore)}`,
      3000,
    )
    check('interceptor drag pans the canvas', panned === true, `from ${panBefore}`)

    // 20. Unlatching is the only thing that disarms, and it must hand clicks back
    //     to the tiles: while armed, the interceptor sits above every tile page.
    const unlatched = await evaluate<{ ok: boolean }>(
      host.dock,
      `window.overlayBridge.action({ kind: 'set-tool', tool: 'select' })`,
    )
    check('select tool action accepted', unlatched.ok === true)
    check(
      'select tool disarms the interceptor',
      await waitFor(() => host.tool() === 'select' && host.mode() === 'compact', 2000),
      `tool=${host.tool()} mode=${host.mode()}`,
    )
    const disarmedStyle = await interceptor()
    check(
      'disarmed interceptor lets clicks through to the tiles again',
      disarmedStyle.pointer === 'none',
      JSON.stringify(disarmedStyle),
    )

    // 20b. A latched hand stays latched while a text field has focus, and Space in
    //      that field changes nothing. The field is reachable because the dock sits
    //      above the interceptor in the view stack — which is also why a focus-driven
    //      disarm is not needed: it only bought a restack that dropped the focus
    //      that caused it, so the hand would flicker off and straight back on.
    await evaluate<{ ok: boolean }>(host.dock, `window.overlayBridge.action({ kind: 'set-tool', tool: 'pan' })`)
    await waitFor(() => host.mode() === 'pan', 2000)
    host.dock.webContents.focus()
    await evaluate<void>(
      host.dock,
      `(() => { const input = document.querySelector('[data-role="omnibox"]'); if (input) input.focus() })()`,
    )
    await wait(250)
    check(
      'a latched hand stays latched while the omnibox has focus',
      host.mode() === 'pan',
      `mode=${host.mode()}`,
    )
    host.dock.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    await wait(200)
    check(
      'Space in the omnibox does not arm or disturb the interceptor',
      host.mode() === 'pan',
      `mode=${host.mode()}`,
    )
    host.dock.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await evaluate<void>(host.dock, `(() => { const input = document.querySelector('[data-role="omnibox"]'); if (input) input.blur() })()`)
    await evaluate<{ ok: boolean }>(host.dock, `window.overlayBridge.action({ kind: 'set-tool', tool: 'select' })`)
    check(
      'hand tool released after the focus checks',
      await waitFor(() => host.mode() === 'compact', 2000),
      `mode=${host.mode()}`,
    )
    host.canvas.webContents.focus()
    await wait(150)

    // 21. The zoom pill reads the live zoom and resets to 100%.
    await evaluate<void>(
      host.canvas,
      `document.getElementById('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true })), undefined`,
    )
    const pillMatches = await waitForEval(
      host.dock,
      `(() => {
        const pill = document.querySelector('[data-role="zoom"]')
        if (!pill) return false
        const shown = parseInt(pill.textContent ?? '', 10)
        return Number.isFinite(shown) && shown !== 100
      })()`,
      3000,
    )
    check('zoom pill shows the live zoom', pillMatches === true)

    const reset = await evaluate<{ ok: boolean }>(
      host.dock,
      `window.overlayBridge.action({ kind: 'zoom-reset' })`,
    )
    check('zoom reset accepted', reset.ok === true)
    check(
      'zoom pill reset returns to exactly 100%',
      await waitFor(() => Math.abs(host.status().zoom - 1) < 0.001, 3000),
      `zoom=${host.status().zoom}`,
    )
    check(
      'the pill reads 100% after the reset',
      await waitForEval(host.dock, `(document.querySelector('[data-role="zoom"]')?.textContent ?? '') === '100%'`, 2000),
    )

    // 22. Fit to view pulls every tile back on screen.
    const fit = await evaluate<{ ok: boolean }>(host.dock, `window.overlayBridge.action({ kind: 'fit-view' })`)
    check('fit to view accepted', fit.ok === true)
    const onScreen = await evaluate<boolean>(
      host.canvas,
      `(() => {
        const tiles = [...document.querySelectorAll('.tile')]
        if (tiles.length === 0) return false
        return tiles.every((tile) => {
          const rect = tile.getBoundingClientRect()
          return rect.right > 0 && rect.bottom > 0 && rect.x < window.innerWidth && rect.y < window.innerHeight
        })
      })()`,
    )
    check('fit to view keeps every tile on screen', onScreen === true)

    // 23. Collapsing the sidebar slides its view to the rail and hides the panel.
    //     A native view cannot be hidden with `transform: translateX(-100%)`: it
    //     keeps its rectangle and would still swallow the clicks it covers, so
    //     the slide is a bounds animation in main and the panel itself goes
    //     display:none. Bounds alone can be right while the panel is still
    //     painted, so both halves are asserted.
    const panelState = (): Promise<{ collapsed: boolean; listVisible: boolean }> =>
      evaluate<{ collapsed: boolean; listVisible: boolean }>(
        host.sidebar,
        `(() => {
          const aside = document.querySelector('[data-role="sidebar"]')
          const list = document.querySelector('[data-role="list"]')
          if (!aside) return { collapsed: false, listVisible: false }
          return {
            collapsed: aside.classList.contains('collapsed'),
            listVisible: !!list && getComputedStyle(list).display !== 'none',
          }
        })()`,
      )
    const openState = await panelState()
    check(
      'sidebar starts expanded at its full width',
      openState.collapsed === false && openState.listVisible === true && host.sidebarBounds().width === SIDEBAR_WIDTH,
      `width=${host.sidebarBounds().width} state=${JSON.stringify(openState)}`,
    )

    const collapsed = await evaluate<{ ok: boolean }>(
      host.sidebar,
      `window.overlayBridge.action({ kind: 'toggle-sidebar' })`,
    )
    check('sidebar collapse accepted', collapsed.ok === true)
    check(
      'collapsed sidebar slides its view to the rail',
      await waitFor(() => host.sidebarBounds().width === SIDEBAR_RAIL_WIDTH, 2000),
      `width=${host.sidebarBounds().width}`,
    )
    const collapsedState = await panelState()
    check(
      'collapsed sidebar hides its panel, not just its width',
      collapsedState.collapsed === true && collapsedState.listVisible === false,
      JSON.stringify(collapsedState),
    )
    await evaluate<{ ok: boolean }>(host.sidebar, `window.overlayBridge.action({ kind: 'toggle-sidebar' })`)
    check(
      'sidebar expands again',
      await waitFor(() => host.sidebarBounds().width === SIDEBAR_WIDTH, 2000),
      `width=${host.sidebarBounds().width}`,
    )
    const expandedState = await panelState()
    check(
      'expanded sidebar shows its panel again',
      expandedState.collapsed === false && expandedState.listVisible === true,
      JSON.stringify(expandedState),
    )

    // 24. The traffic lights. A synthetic button.click() bypasses the press
    //     sequence entirely, so these go through Electron's real input pipeline:
    //     a mouseMove/mouseDown/mouseUp triple at the dot's own coordinate, hit
    //     tested by Blink exactly as a human press is. Anything that swallows the
    //     press — a re-parented node, a drag handler starting a capture, a view
    //     covering the bar — leaves no click for the button to answer.
    const lightsCreated = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'create', input: 'data:text/html,%3Ctitle%3ETraffic%20Lights%3C/title%3E' })`,
    )
    check('tile created for the traffic light checks', lightsCreated.ok === true, lightsCreated.error ?? '')
    await waitForEval(
      host.canvas,
      `[...document.querySelectorAll('.tile-label')].some((el) => (el.textContent ?? '') === 'Traffic Lights')`,
      8000,
    )
    const lightsId = await evaluate<string | null>(
      host.canvas,
      `(() => {
        const el = [...document.querySelectorAll('.tile')].find((node) => (node.querySelector('.tile-label')?.textContent ?? '') === 'Traffic Lights')
        return el ? el.dataset.tileId : null
      })()`,
    )
    check('found the tile whose lights are under test', typeof lightsId === 'string', String(lightsId))

    /** Centre the tile first: a light outside the window cannot be pressed. */
    await evaluate<boolean>(
      host.sidebar,
      `(() => {
        const row = document.querySelector('[data-tile-id=${JSON.stringify(String(lightsId))}]')
        if (!(row instanceof HTMLElement)) return false
        row.click()
        return true
      })()`,
    )
    await waitForEval(
      host.canvas,
      `(() => {
        const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
        if (!el) return false
        const r = el.getBoundingClientRect()
        return Math.abs(r.x + r.width / 2 - window.innerWidth / 2) <= 2 && Math.abs(r.y + r.height / 2 - window.innerHeight / 2) <= 2
      })()`,
      2000,
    )

    // Isolate: any other tile whose view sits above this bar would swallow the
    // press before the canvas ever saw it, and the light would look dead for a
    // reason that has nothing to do with the button. Close the rest, which also
    // proves the handlers are bound at all (a synthetic click skips the press).
    const closedOthers = await evaluate<number>(
      host.canvas,
      `(() => {
        let closed = 0
        for (const node of [...document.querySelectorAll('.tile')]) {
          if (node.dataset.tileId === ${JSON.stringify(String(lightsId))}) continue
          const button = node.querySelector('.light.close')
          if (button instanceof HTMLElement) {
            button.click()
            closed += 1
          }
        }
        return closed
      })()`,
    )
    check(
      'canvas isolated to the tile under test',
      await waitFor(() => host.registry.size === 1, 4000),
      `closed ${closedOthers}, tiles=${host.registry.size}`,
    )

    // A real press must reach the canvas document at all: drag the title bar
    // through the input pipeline and watch the frame move. If this fails, the
    // coordinates are wrong and every light check below is meaningless.
    const barRect = await evaluate<Rect | null>(
      host.canvas,
      `(() => {
        const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
        if (!el) return null
        const r = el.querySelector('.tile-chrome').getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })()`,
    )
    const beforePress = await evaluate<Rect | null>(
      host.canvas,
      `(() => {
        const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })()`,
    )
    if (barRect) {
      const gx = Math.round(barRect.x + 120)
      const gy = Math.round(barRect.y + barRect.height / 2)
      host.canvas.webContents.focus()
      host.canvas.webContents.sendInputEvent({ type: 'mouseMove', x: gx, y: gy })
      host.canvas.webContents.sendInputEvent({ type: 'mouseDown', x: gx, y: gy, button: 'left', clickCount: 1 })
      for (const step of [10, 20, 30]) {
        host.canvas.webContents.sendInputEvent({ type: 'mouseMove', x: gx + step, y: gy + step, button: 'left' })
        await wait(30)
      }
      host.canvas.webContents.sendInputEvent({ type: 'mouseUp', x: gx + 30, y: gy + 30, button: 'left', clickCount: 1 })
      await wait(200)
    }
    const afterPress = await evaluate<Rect | null>(
      host.canvas,
      `(() => {
        const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })()`,
    )
    check(
      'a real press on the title bar reaches the canvas',
      barRect !== null &&
        beforePress !== null &&
        afterPress !== null &&
        Math.abs(afterPress.x - beforePress.x - 30) <= 3 &&
        Math.abs(afterPress.y - beforePress.y - 30) <= 3,
      `moved ${Math.round((afterPress?.x ?? 0) - (beforePress?.x ?? 0))},${Math.round((afterPress?.y ?? 0) - (beforePress?.y ?? 0))}`,
    )

    // Put the tile back under the camera before pressing the dots.
    await evaluate<boolean>(
      host.sidebar,
      `(() => {
        const row = document.querySelector('[data-tile-id=${JSON.stringify(String(lightsId))}]')
        if (!(row instanceof HTMLElement)) return false
        row.click()
        return true
      })()`,
    )
    await wait(400)

    const lightRect = (role: string): Promise<Rect | null> =>
      evaluate<Rect | null>(
        host.canvas,
        `(() => {
          const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
          const dot = el ? el.querySelector('[data-role="${role}"]') : null
          if (!dot) return null
          const r = dot.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        })()`,
      )

    /** Press a light through the real input pipeline and let the click land. */
    const pressLight = async (role: string): Promise<Rect | null> => {
      const rect = await lightRect(role)
      if (!rect) return null
      const x = Math.round(rect.x + rect.width / 2)
      const y = Math.round(rect.y + rect.height / 2)
      if (x < 0 || y < 0 || x >= windowRect.width || y >= windowRect.height) return null
      host.canvas.webContents.focus()
      host.canvas.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      host.canvas.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      await wait(90)
      host.canvas.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      await wait(180)
      return rect
    }

    const frameSize = (): Promise<{ height: number; chrome: number } | null> =>
      evaluate<{ height: number; chrome: number } | null>(
        host.canvas,
        `(() => {
          const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
          if (!el) return null
          const frame = el.getBoundingClientRect()
          const chrome = el.querySelector('.tile-chrome').getBoundingClientRect()
          return { height: frame.height, chrome: chrome.height }
        })()`,
      )

    // 24a-pre. The dots must be reachable at all: no drag region over them, and
    //         their own stacking order. Then the hover glyphs, which only appear
    //         while the pointer is inside the group — driven as real hover here,
    //         because a dispatched mouseover does not set :hover.
    const affordance = await evaluate<{ pointer: string; drag: string; z: string; glyphs: string[] } | null>(
      host.canvas,
      `(() => {
        const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
        if (!el) return null
        const lights = el.querySelector('.lights')
        if (!lights) return null
        const style = getComputedStyle(lights)
        return {
          pointer: style.pointerEvents,
          drag: style.getPropertyValue('-webkit-app-region'),
          z: style.zIndex,
          glyphs: [...lights.querySelectorAll('.light')].map((dot) => getComputedStyle(dot, '::after').content),
        }
      })()`,
    )
    check(
      'traffic lights opt out of the drag region and sit above the bar',
      affordance !== null && affordance.pointer === 'auto' && affordance.drag !== 'drag' && Number(affordance.z) >= 10,
      JSON.stringify(affordance),
    )
    check(
      'each light carries its macOS glyph',
      affordance !== null &&
        affordance.glyphs.length === 3 &&
        affordance.glyphs.every((glyph) => glyph !== 'none' && glyph !== 'normal' && glyph.length > 2),
      JSON.stringify(affordance?.glyphs ?? null),
    )

    const glyphOpacity = (): Promise<string | null> =>
      evaluate<string | null>(
        host.canvas,
        `(() => {
          const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
          const dot = el ? el.querySelector('.light.collapse') : null
          return dot ? getComputedStyle(dot, '::after').opacity : null
        })()`,
      )
    /** Poll the glyph opacity: a fixed sleep races the CSS transition. */
    const opacitySettles = async (expected: string): Promise<boolean> => {
      const deadline = Date.now() + 2000
      for (;;) {
        if ((await glyphOpacity()) === expected) return true
        if (Date.now() > deadline) return false
        await wait(40)
      }
    }
    const hoverRect = await lightRect('collapse')
    if (hoverRect) {
      host.canvas.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(hoverRect.x + hoverRect.width / 2),
        y: Math.round(hoverRect.y + hoverRect.height / 2),
      })
    }
    check('hovering the lights reveals their glyph', await opacitySettles('1'), `opacity=${await glyphOpacity()}`)
    host.canvas.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 })
    check('leaving the lights hides the glyphs again', await opacitySettles('0'), `opacity=${await glyphOpacity()}`)

    // 24a. Yellow: collapse to the title bar, and take the page view with it.
    const yellowHit = await pressLight('collapse')
    check('yellow light is pressable where it is drawn', yellowHit !== null, JSON.stringify(yellowHit))
    const shrunk = await waitForEval(
      host.canvas,
      `(() => {
        const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
        if (!el) return false
        const frame = el.getBoundingClientRect()
        const chrome = el.querySelector('.tile-chrome').getBoundingClientRect()
        return Math.abs(frame.height - chrome.height) <= 1
      })()`,
      2000,
    )
    const shrunkSize = await frameSize()
    check(
      'yellow light collapses the frame to its title bar',
      shrunk === true,
      `${Math.round(shrunkSize?.height ?? -1)}px frame vs ${Math.round(shrunkSize?.chrome ?? -1)}px title bar`,
    )
    check(
      'collapsed tile hides its page view',
      await waitFor(() => host.registry.visibleOf(String(lightsId)) === false, 2000),
      `visible=${String(host.registry.visibleOf(String(lightsId)))}`,
    )
    const collapsedBounds = host.registry.boundsOf(String(lightsId))
    check(
      'collapsed tile gives the page view zero height',
      collapsedBounds === null || collapsedBounds.height <= 1,
      JSON.stringify(collapsedBounds),
    )

    // 24b. Yellow again: the previous height comes back, page and all.
    await pressLight('collapse')
    const restoredBounds = await waitFor(() => (host.registry.boundsOf(String(lightsId))?.height ?? 0) > 100, 2000)
    check('yellow light restores the tile height', restoredBounds === true, JSON.stringify(host.registry.boundsOf(String(lightsId))))
    check(
      'restored tile shows its page again',
      await waitFor(() => host.registry.visibleOf(String(lightsId)) === true, 2000),
      `visible=${String(host.registry.visibleOf(String(lightsId)))}`,
    )

    // 24c. Green: the camera comes to this tile. Drag the tile well off centre
    //      first, so a no-op fit cannot pass, and leave the zoom alone — the dots
    //      stay drawn at this zoom, which is what makes them pressable at all.
    const zoomBeforeFit = host.status().zoom
    await dragBy(String(lightsId), -320, -180)
    check(
      'tile dragged off centre before pressing green',
      await waitForEval(
        host.canvas,
        `(() => {
          const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
          if (!el) return false
          const r = el.getBoundingClientRect()
          return Math.abs(r.x + r.width / 2 - window.innerWidth / 2) > 60
        })()`,
        2000,
      ),
    )
    await wait(150)
    const footprintBefore = await evaluate<Rect | null>(
      host.canvas,
      `(() => {
        const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
        if (!el) return null
        const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--zoom')) || 1
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width / zoom, height: r.height / zoom }
      })()`,
    )
    // What a fit of *this* tile in *this* window has to land on: the tile's own
    // world footprint minus the padding, capped at the fit ceiling.
    const expectedFit =
      footprintBefore === null
        ? 1
        : Math.min(
            FIT_MAX_ZOOM,
            (windowRect.width - FIT_PADDING * 2) / footprintBefore.width,
            (windowRect.height - FIT_PADDING * 2) / footprintBefore.height,
          )
    await pressLight('fit')
    const fitted = await waitForEval(
      host.canvas,
      `(() => {
        const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
        if (!el) return false
        const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--zoom')) || 1
        const r = el.getBoundingClientRect()
        const centred = Math.abs(r.x + r.width / 2 - window.innerWidth / 2) <= 2 && Math.abs(r.y + r.height / 2 - window.innerHeight / 2) <= 2
        const inside = r.x >= 0 && r.y >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight
        return centred && inside && Math.abs(zoom - ${expectedFit}) <= 0.02
      })()`,
      3000,
    )
    check(
      'green light centres and fits the tile in the viewport',
      fitted === true,
      `zoom=${host.status().zoom} expected=${expectedFit.toFixed(3)} before=${zoomBeforeFit}`,
    )
    check('green light never zooms past the fit ceiling', host.status().zoom <= FIT_MAX_ZOOM + 0.001, `zoom=${host.status().zoom}`)
    // The move is a tween: let it land, then read the camera the chrome reports.
    await wait(400)
    check(
      'camera settles exactly on the fit zoom',
      Math.abs(host.status().zoom - expectedFit) <= 0.001,
      `zoom=${host.status().zoom} expected=${expectedFit.toFixed(3)}`,
    )
    // The discriminating check: a fit moves the camera. A tile that grew to fill
    // the viewport would satisfy "centred and inside" too, so compare the world
    // footprint — screen size divided by the zoom the renderer applied.
    const footprintAfter = await evaluate<Rect | null>(
      host.canvas,
      `(() => {
        const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})
        if (!el) return null
        const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--zoom')) || 1
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width / zoom, height: r.height / zoom }
      })()`,
    )
    check(
      'green light moves the camera, not the tile',
      footprintBefore !== null &&
        footprintAfter !== null &&
        Math.abs(footprintAfter.width - footprintBefore.width) <= 2 &&
        Math.abs(footprintAfter.height - footprintBefore.height) <= 2,
      `${footprintBefore?.width.toFixed(1)}x${footprintBefore?.height.toFixed(1)} -> ${footprintAfter?.width.toFixed(1)}x${footprintAfter?.height.toFixed(1)} world px`,
    )

    // 24d. Red: the tile and its view both go, and the registry count drops.
    const beforeClose = host.registry.size
    const redHit = await pressLight('close')
    check('red light is pressable where it is drawn', redHit !== null, JSON.stringify(redHit))
    check(
      'red light destroys the tile',
      await waitFor(() => host.registry.size === beforeClose - 1, 3000),
      `${beforeClose} -> ${host.registry.size}`,
    )
    check(
      'red light removes the frame from the canvas',
      await waitForEval(
        host.canvas,
        `![...document.querySelectorAll('.tile')].some((node) => node.dataset.tileId === ${JSON.stringify(String(lightsId))})`,
        2000,
      ),
    )
    check('red light leaves no view behind', host.registry.boundsOf(String(lightsId)) === null)

    // 25. Sessions. Two tiles share one persistent jar (sign in once, every tile
    //     is signed in), a tile that asks for its own container is still
    //     isolated, and the flush the quit path runs is bounded so it cannot
    //     wedge a ⌘Q.
    const beforeSessions = host.registry.size
    const cookieUrl = 'https://canvas-session.test/'
    const expires = Math.floor(Date.now() / 1000) + 3600
    const tileA = 'session-a'
    const tileB = 'session-b'
    const tileWork = 'session-work'
    const tileBad = 'session-bad'
    const slot = (index: number): Rect => ({ x: 60 + index * 380, y: 60, width: 320, height: 240 })

    host.registry.create(tileA, 'about:blank', slot(0), 1)
    host.registry.create(tileB, 'about:blank', slot(1), 1)
    check('both session tiles created', host.registry.size === beforeSessions + 2, `tiles=${host.registry.size}`)
    check(
      'tiles default to the shared persistent partition',
      host.registry.partitionOf(tileA) === DEFAULT_TILE_PARTITION &&
        host.registry.partitionOf(tileB) === DEFAULT_TILE_PARTITION,
      `${String(host.registry.partitionOf(tileA))} / ${String(host.registry.partitionOf(tileB))}`,
    )

    const jarA = host.registry.sessionOf(tileA)
    const jarB = host.registry.sessionOf(tileB)
    check('two tiles are backed by the same session object', jarA !== null && jarA === jarB)

    let written = false
    if (jarA) {
      await jarA.cookies.set({ url: cookieUrl, name: 'cb_shared', value: 'from-tile-1', expirationDate: expires })
      written = true
    }
    check('a cookie was written through the first tile', written)
    const viaTileB: Cookie[] = jarB ? await jarB.cookies.get({ url: cookieUrl, name: 'cb_shared' }) : []
    check(
      'a cookie set in tile 1 is readable by tile 2',
      viaTileB.length === 1 && viaTileB[0]?.value === 'from-tile-1',
      JSON.stringify(viaTileB.map((cookie) => cookie.value)),
    )

    // 25b. Opting into a container still isolates, or the shared default would be
    //      a privacy regression rather than a convenience.
    host.registry.create(tileWork, 'about:blank', slot(2), 1, 'persist:smoke-work')
    const jarWork = host.registry.sessionOf(tileWork)
    check(
      'a custom container is honoured verbatim',
      host.registry.partitionOf(tileWork) === 'persist:smoke-work',
      String(host.registry.partitionOf(tileWork)),
    )
    check('a custom container gets its own session', jarWork !== null && jarWork !== jarA)

    const workSeesShared: Cookie[] = jarWork ? await jarWork.cookies.get({ url: cookieUrl, name: 'cb_shared' }) : []
    check(
      'the shared cookie is invisible inside a custom container',
      workSeesShared.length === 0,
      JSON.stringify(workSeesShared.map((cookie) => cookie.name)),
    )
    if (jarWork) {
      await jarWork.cookies.set({ url: cookieUrl, name: 'cb_work', value: 'container-only', expirationDate: expires })
    }
    const sharedSeesWork: Cookie[] = jarA ? await jarA.cookies.get({ url: cookieUrl, name: 'cb_work' }) : []
    check(
      'a container cookie stays out of the shared jar',
      sharedSeesWork.length === 0,
      JSON.stringify(sharedSeesWork.map((cookie) => cookie.name)),
    )

    // 25c. A malformed container is not a storage key: it normalises to the
    //      shared jar instead of inventing a directory out of junk.
    host.registry.create(tileBad, 'about:blank', slot(3), 1, 'persist:../../etc')
    check(
      'an invalid container falls back to the shared jar',
      host.registry.partitionOf(tileBad) === DEFAULT_TILE_PARTITION,
      String(host.registry.partitionOf(tileBad)),
    )

    // 25d. Flush AFTER the views are gone, which is the order `before-quit`
    //      really runs in: the window clears its child views before the quit.
    for (const id of [tileA, tileB, tileWork, tileBad]) host.registry.destroy(id)
    check('session tiles are cleaned up', host.registry.size === beforeSessions, `tiles=${host.registry.size}`)

    const used = host.registry.partitionsUsed()
    check(
      'the quit flush still knows every partition after teardown',
      used.includes(DEFAULT_TILE_PARTITION) && used.includes('persist:smoke-work'),
      used.join(','),
    )

    const flushStarted = Date.now()
    const report = await flushCookieStores(used, (partition) => session.fromPartition(partition))
    const flushElapsed = Date.now() - flushStarted
    check(
      'cookie stores flush without hanging teardown',
      report.timedOut.length === 0 && report.failed.length === 0,
      `flushed=${report.flushed.join(',')} timedOut=${report.timedOut.join(',')} failed=${report.failed.join(',')} in ${flushElapsed}ms`,
    )
    check('the flush finishes inside its budget', flushElapsed < 2000, `${flushElapsed}ms`)

    const afterFlush: Cookie[] = await session
      .fromPartition(DEFAULT_TILE_PARTITION)
      .cookies.get({ url: cookieUrl, name: 'cb_shared' })
    check(
      'the shared cookie survives the flush',
      afterFlush.length === 1 && afterFlush[0]?.value === 'from-tile-1',
      JSON.stringify(afterFlush.map((cookie) => cookie.value)),
    )

    // Leave nothing in the jars a later run could inherit.
    await session.fromPartition(DEFAULT_TILE_PARTITION).cookies.remove(cookieUrl, 'cb_shared')
    await session.fromPartition('persist:smoke-work').cookies.remove(cookieUrl, 'cb_work')

    // 25e. Container management. A tile opens in a named container, the sidebar
    //      panel lists the jars that are actually open, and moving the tile
    //      re-opens it on the chosen partition. The move assertion is the
    //      registry's partition *and* the rebuilt view's bounds *and* the rendered
    //      badge: a partition string alone would also be true of a view that was
    //      never rebuilt, which is the failure this path exists to avoid.
    const beforeMove = host.registry.size
    const inContainer = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'create', input: '@smoke-move about:blank' })`,
    )
    check('a tile opens in a named container', inContainer.ok === true, inContainer.error ?? '')
    await waitFor(() => host.registry.size === beforeMove + 1, 3000)
    const containerTile = host.inventory().find((tile) => tile.partition === 'persist:smoke-move') ?? null
    check(
      'the inventory reports the tile’s container',
      containerTile !== null,
      JSON.stringify(host.inventory().map((tile) => tile.partition ?? null)),
    )
    const containerId = containerTile?.id ?? ''

    const panelButton = await evaluate<boolean>(
      host.sidebar,
      `(() => {
        const button = document.querySelector('[data-role="containers"]')
        if (!button) return false
        button.click()
        return true
      })()`,
    )
    check('the sidebar exposes a containers button', panelButton === true)
    const panelListed = await waitForEval(
      host.sidebar,
      `(() => {
        const menu = document.querySelector('[data-role="ctr-menu"]')
        if (!menu || menu.hidden) return false
        return (
          menu.querySelector('[data-partition="persist:main"]') !== null &&
          menu.querySelector('[data-partition="persist:smoke-move"]') !== null
        )
      })()`,
    )
    check('the container panel lists the shared jar and the open containers', panelListed === true)

    // The picker's whole point: choosing a jar arms the dock's omnibox with the
    // prefix, so the next keystroke is an address. Asserted on the dock's own input
    // value, because that is the only place the gesture actually lands.
    await evaluate<boolean>(
      host.sidebar,
      `(() => {
        const row = document.querySelector('[data-partition="persist:smoke-move"]')
        if (!row) return false
        row.click()
        return true
      })()`,
    )
    const armedPrefix = await waitForEval(
      host.dock,
      `document.querySelector('[data-role="omnibox"]').value === '@smoke-move '`,
    )
    check('picking a container arms the dock omnibox with its prefix', armedPrefix === true)

    // ...and the shared row's empty prefix clears it again, which is what makes the
    // panel a picker rather than a one-way switch.
    await evaluate<{ ok: boolean }>(host.overlay, `window.overlayBridge.action({ kind: 'focus-omnibox', prefix: '' })`)
    const clearedField = await waitForEval(
      host.dock,
      `document.querySelector('[data-role="omnibox"]').value === ''`,
    )
    check('the shared row clears the armed prefix', clearedField === true)

    const moved = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'move-tile', id: ${JSON.stringify(containerId)}, partition: 'persist:smoke-work' })`,
    )
    check('moving an open tile into another container is accepted', moved.ok === true, moved.error ?? '')
    await waitFor(() => host.registry.partitionOf(containerId) === 'persist:smoke-work', 3000)
    check(
      'the moved tile runs in the target container',
      host.registry.partitionOf(containerId) === 'persist:smoke-work',
      String(host.registry.partitionOf(containerId)),
    )
    check(
      'the rebuilt view got bounds back',
      host.registry.boundsOf(containerId) !== null,
      JSON.stringify(host.registry.boundsOf(containerId)),
    )
    const movedBadge = await evaluate<string>(
      host.canvas,
      `document.querySelector('[data-tile-id=${JSON.stringify(containerId)}] .tile-badge')?.textContent ?? ''`,
    )
    check('the tile’s badge follows the move', movedBadge === 'smoke-work', movedBadge)

    const backToShared = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'move-tile', id: ${JSON.stringify(containerId)}, partition: '${DEFAULT_TILE_PARTITION}' })`,
    )
    check('a tile can be moved back to the shared jar', backToShared.ok === true, backToShared.error ?? '')
    await waitFor(() => host.registry.partitionOf(containerId) === DEFAULT_TILE_PARTITION, 3000)
    const sharedBadgeHidden = await evaluate<boolean>(
      host.canvas,
      `document.querySelector('[data-tile-id=${JSON.stringify(containerId)}] .tile-badge')?.hidden === true`,
    )
    check('the badge disappears on the shared jar', sharedBadgeHidden === true)

    const refusedMove = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'move-tile', id: ${JSON.stringify(containerId)}, partition: 'persist:../etc' })`,
    )
    check('a move to a malformed container is refused', refusedMove.ok === false, refusedMove.error ?? 'accepted')
    check(
      'the refused move left the tile where it was',
      host.registry.partitionOf(containerId) === DEFAULT_TILE_PARTITION,
      String(host.registry.partitionOf(containerId)),
    )

    // 25f. Clearing a container. The cookie it held is gone, and the shared jar is
    //      refused, so the destructive path cannot quietly become "sign out of
    //      every tile in the app".
    const clearJar = session.fromPartition('persist:smoke-clear')
    await clearJar.cookies.set({ url: cookieUrl, name: 'cb_clear', value: 'erase-me', expirationDate: expires })
    const beforeClear: Cookie[] = await clearJar.cookies.get({ url: cookieUrl, name: 'cb_clear' })
    check('the container holds a cookie to clear', beforeClear.length === 1, `${beforeClear.length} found`)

    const cleared = await evaluate<{ ok: boolean; error?: string }>(
      host.sidebar,
      `window.overlayBridge.clearContainer('persist:smoke-clear')`,
    )
    check('clearing a container is accepted', cleared.ok === true, cleared.error ?? '')
    const afterClear: Cookie[] = await clearJar.cookies.get({ url: cookieUrl, name: 'cb_clear' })
    check('the cleared container lost its cookie', afterClear.length === 0, `${afterClear.length} left`)

    const sharedRefused = await evaluate<{ ok: boolean; error?: string }>(
      host.sidebar,
      `window.overlayBridge.clearContainer('${DEFAULT_TILE_PARTITION}')`,
    )
    check('the shared jar is refused a clear', sharedRefused.ok === false, sharedRefused.error ?? 'accepted')

    if (containerId !== '') {
      await evaluate<{ ok: boolean; error?: string }>(
        host.overlay,
        `window.overlayBridge.action({ kind: 'tile-close', id: ${JSON.stringify(containerId)} })`,
      )
    }
    await waitFor(() => host.registry.size === beforeMove, 3000)
    check('the container tile is cleaned up', host.registry.size === beforeMove, `tiles=${host.registry.size}`)

    // 26. Cascade placement, forced. Two ⌘N spawns without moving the cursor ask
    //     for the same world rect, so the second one must cascade or the two
    //     title bars end up on top of each other. Reads world coordinates out of
    //     a real save, because that is the model a reload would use.
    const beforeCascade = host.registry.size
    for (let index = 0; index < 2; index += 1) {
      await evaluate<void>(
        host.canvas,
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })), undefined`,
      )
      if (!(await waitFor(() => host.mode() === 'omnibox', 2000))) {
        check('omnibox opened for a cascade spawn', false, `mode=${host.mode()}`)
        break
      }
      const born = await evaluate<{ ok: boolean; error?: string }>(
        host.overlay,
        `window.overlayBridge.action({ kind: 'create', input: 'about:blank' })`,
      )
      check(`cascade spawn ${index + 1} accepted`, born.ok === true, born.error ?? '')
      await waitFor(() => host.registry.size === beforeCascade + index + 1, 3000)
    }
    check(
      'both cascade spawns landed',
      host.registry.size === beforeCascade + 2,
      `tiles=${host.registry.size}`,
    )

    const cascadeSaved = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'save', name: 'cascade-check' })`,
    )
    check('cascade workspace saved', cascadeSaved.ok === true, cascadeSaved.error ?? '')
    const cascadeTiles = (await host.store.load('cascade-check'))?.tiles ?? []
    const firstSpawn = cascadeTiles[cascadeTiles.length - 2]?.world ?? null
    const secondSpawn = cascadeTiles[cascadeTiles.length - 1]?.world ?? null
    const stepX = firstSpawn && secondSpawn ? secondSpawn.x - firstSpawn.x : 0
    const stepY = firstSpawn && secondSpawn ? secondSpawn.y - firstSpawn.y : 0
    check(
      'the second spawn cascades off the first instead of landing on it',
      firstSpawn !== null &&
        secondSpawn !== null &&
        // Identical coordinates would be 0,0. A cascade moves at least one stride
        // along an axis, never backwards (right, then down, then diagonal).
        (stepX >= CASCADE_STEP_WORLD || stepY >= CASCADE_STEP_WORLD) &&
        stepX >= 0 &&
        stepY >= 0 &&
        !intersects(firstSpawn, secondSpawn),
      `first=${firstSpawn?.x},${firstSpawn?.y} second=${secondSpawn?.x},${secondSpawn?.y} step=${stepX},${stepY} stride=${CASCADE_STEP_WORLD}`,
    )

    // 27. Ad and tracker blocking. The list must be loaded, every session the app
    //     runs on must be wired, and a request to a listed host must die before it
    //     reaches the network. The probe is a data: page — it has no host of its
    //     own, so its beacon is third-party by construction and needs no DNS.
    const blockerBase = host.blocker()
    check(
      'adblock list loaded and parsed',
      blockerBase.entries > 40000,
      `${blockerBase.entries} hostnames in ${blockerBase.loadMs}ms`,
    )
    check(
      'adblock wired to the chrome and tile sessions',
      blockerBase.instances >= 5,
      `instances=${blockerBase.instances}`,
    )

    // Both sides in one page: a listed host that must die, and an unlisted host
    // that must be let through. The counters move on the *decision*, so this
    // needs no network even though the allowed image will fail to load.
    // Note the filter is `*://*/*`: file:, data: and about: never reach the
    // listener at all, which is why "allowed" only counts real http(s).
    const beaconUrl = `data:text/html,${encodeURIComponent(
      '<title>beacon</title>' +
        '<img src="https://ib.adnxs.com/getuid?cb=smoke" alt="">' +
        '<img src="https://example.com/not-a-tracker.png" alt="">',
    )}`
    const beacon = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'create', input: ${JSON.stringify(beaconUrl)} })`,
    )
    check('blocker probe page created', beacon.ok === true, beacon.error ?? '')
    await waitFor(() => host.blocker().blocked > blockerBase.blocked, 4000)
    await waitFor(() => host.blocker().allowed > blockerBase.allowed, 4000)
    const afterBeacon = host.blocker()
    check(
      'a listed tracker request is cancelled',
      afterBeacon.blocked > blockerBase.blocked && afterBeacon.lastBlocked.includes('ib.adnxs.com'),
      `blocked +${afterBeacon.blocked - blockerBase.blocked} last=${afterBeacon.lastBlocked.join(',')}`,
    )
    check(
      'an unlisted request is let through',
      afterBeacon.allowed > blockerBase.allowed && !afterBeacon.lastBlocked.includes('example.com'),
      `allowed +${afterBeacon.allowed - blockerBase.allowed} last=${afterBeacon.lastBlocked.join(',')}`,
    )

    // 28. Container syntax in the omnibox. A badge on the wrong jar would be
    //     worse than no badge, so both halves are asserted: the registry's real
    //     partition and the pill rendered in the tile's own chrome. Then the
    //     workspace is reloaded from disk, which is the path a restart takes.
    const badgeProbe = (id: string, label: string): string =>
      `(() => { const el = document.querySelector(${JSON.stringify(
        `.tile[data-tile-id="${id}"] .tile-badge`,
      )}); return !!el && el.hidden === false && el.textContent === ${JSON.stringify(label)} })()`

    const beforeContainer = new Set(host.registry.ids)
    const containerBorn = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'create', input: '@isolated https://example.com' })`,
    )
    check('container prefix accepted', containerBorn.ok === true, containerBorn.error ?? '')
    await waitFor(() => host.registry.size === beforeContainer.size + 1, 4000)
    const isolatedId = host.registry.ids.find((id) => !beforeContainer.has(id)) ?? null
    check('the prefixed spawn created a tile', isolatedId !== null, `tiles=${host.registry.size}`)
    check(
      'the tile runs in the requested container',
      isolatedId !== null && host.registry.partitionOf(isolatedId) === 'persist:isolated',
      isolatedId === null ? 'no tile' : String(host.registry.partitionOf(isolatedId)),
    )
    check(
      'the tile chrome badges the container',
      isolatedId !== null && (await waitForEval(host.canvas, badgeProbe(isolatedId, 'isolated'), 3000)),
      isolatedId === null ? 'no tile' : isolatedId,
    )

    // The default jar stays unbadged: a pill on almost every tile would be noise.
    const plainId = host.registry.ids.find(
      (id) => id !== isolatedId && host.registry.partitionOf(id) === DEFAULT_TILE_PARTITION,
    ) ?? null
    const plainBadgeProbe = `(() => { const el = document.querySelector(${JSON.stringify(
      `.tile[data-tile-id="${plainId ?? ''}"] .tile-badge`,
    )}); return !!el && el.hidden === true && el.textContent === '' })()`
    check(
      'a shared-jar tile carries no container badge',
      plainId !== null && (await waitForEval(host.canvas, plainBadgeProbe, 3000)),
      String(plainId),
    )

    // `@temp` is the other half of the vocabulary: a jar of its own that is gone
    // at quit, and a badge that says so rather than showing a random name.
    const tempBorn = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'create', input: '@temp https://example.com' })`,
    )
    check('@temp accepted', tempBorn.ok === true, tempBorn.error ?? '')
    await waitFor(() => host.registry.size === beforeContainer.size + 2, 4000)
    const tempId = host.registry.ids.find((id) => !beforeContainer.has(id) && id !== isolatedId) ?? null
    const tempPartition = tempId === null ? null : host.registry.partitionOf(tempId)
    check(
      'a private tile gets its own in-memory container',
      tempPartition !== null &&
        tempPartition.startsWith('temp:') &&
        tempPartition !== DEFAULT_TILE_PARTITION &&
        tempPartition !== 'persist:isolated',
      String(tempPartition),
    )
    check(
      'an in-memory container is badged as temp',
      tempId !== null && (await waitForEval(host.canvas, badgeProbe(tempId, 'temp'), 3000)),
      String(tempId),
    )

    const containerSaved = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'save', name: 'container-check' })`,
    )
    check('container workspace saved', containerSaved.ok === true, containerSaved.error ?? '')
    const containerTiles = (await host.store.load('container-check'))?.tiles ?? []
    const persisted = containerTiles.find((tile) => tile.id === isolatedId) ?? null
    check(
      'the container travels with the saved tile',
      persisted?.partition === 'persist:isolated',
      JSON.stringify(persisted ?? null),
    )
    const persistedTemp = containerTiles.find((tile) => tile.id === tempId) ?? null
    check(
      'the private container is saved too, so its badge survives a reload',
      persistedTemp !== null && persistedTemp.partition === tempPartition,
      JSON.stringify(persistedTemp ?? null),
    )

    // Reload through the same path a restart takes: the record is the only thing
    // that survives, so the partition and the badge have to come back from it.
    const containerReload = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'switch', name: 'container-check' })`,
    )
    check('container workspace reloads', containerReload.ok === true, containerReload.error ?? '')
    check(
      'the reloaded tile is back in its container',
      isolatedId !== null && (await waitFor(() => host.registry.partitionOf(isolatedId) === 'persist:isolated', 4000)),
      isolatedId === null ? 'no tile' : String(host.registry.partitionOf(isolatedId)),
    )
    check(
      'the reloaded tile is badged again',
      isolatedId !== null && (await waitForEval(host.canvas, badgeProbe(isolatedId, 'isolated'), 3000)),
    )

    // 29. Dock and sidebar ergonomics. The counter, the chips and the row badge
    //     all read the inventory the canvas pushes, so each is asserted against
    //     live state rather than against a second copy of the tile list.
    const expectedCount = `${host.registry.size} tile${host.registry.size === 1 ? '' : 's'}`
    const counter = await waitForEval(
      host.dock,
      `(document.querySelector('[data-role="count"]')?.textContent ?? '') === ${JSON.stringify(expectedCount)}`,
      3000,
    )
    check('dock counter pill shows the live tile count', counter === true, expectedCount)

    const widthBeforePill = host.sidebarBounds().width
    await evaluate<void>(
      host.dock,
      `(() => { const el = document.querySelector('[data-role="count"]'); if (el instanceof HTMLElement) el.click() })()`,
    )
    check(
      'counter pill toggles the sidebar',
      await waitFor(() => host.sidebarBounds().width !== widthBeforePill, 3000),
      `${widthBeforePill} -> ${host.sidebarBounds().width}`,
    )
    await evaluate<void>(
      host.dock,
      `(() => { const el = document.querySelector('[data-role="count"]'); if (el instanceof HTMLElement) el.click() })()`,
    )
    check(
      'counter pill restores the sidebar',
      await waitFor(() => host.sidebarBounds().width === SIDEBAR_WIDTH, 3000),
      `width=${host.sidebarBounds().width}`,
    )

    // Each chrome view owns the keyboard while it has focus, so the shortcut has
    // to work from the panel as well as from the canvas. Synthetic keydown: this
    // asserts the listener wiring, not the native input path.
    const pressB = (): Promise<void> =>
      evaluate<void>(
        host.sidebar,
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', metaKey: true, bubbles: true }))`,
      )
    await pressB()
    check(
      '⌘B collapses the sidebar while the panel has focus',
      await waitFor(() => host.sidebarBounds().width === SIDEBAR_RAIL_WIDTH, 3000),
      `width=${host.sidebarBounds().width}`,
    )
    await pressB()
    check(
      '⌘B expands it again',
      await waitFor(() => host.sidebarBounds().width === SIDEBAR_WIDTH, 3000),
      `width=${host.sidebarBounds().width}`,
    )

    // Typing `@` is the one moment the dock teaches its own syntax: the chips
    // name containers that already exist, plus temp, and a click completes the
    // prefix without launching anything.
    await evaluate<void>(
      host.dock,
      `(() => {
        const input = document.querySelector('[data-role="omnibox"]')
        if (!(input instanceof HTMLInputElement)) return
        input.focus()
        input.value = '@'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`,
    )
    check(
      'typing @ offers the live containers plus temp',
      await waitForEval(
        host.dock,
        `(() => {
          const box = document.querySelector('[data-role="chips"]')
          if (!(box instanceof HTMLElement) || box.hidden) return false
          const labels = [...box.querySelectorAll('[data-chip]')].map((el) => el.dataset.chip)
          return labels.includes('isolated') && labels.includes('temp')
        })()`,
        3000,
      ),
    )
    // The row is only 56px: the suggestions have to displace the controls, and a
    // CSS rule keyed off the wrong attribute would leave both crammed in.
    check(
      'typing @ yields the dock row to the chips',
      await waitForEval(
        host.dock,
        `getComputedStyle(document.querySelector('[data-role="zoom"]')).display === 'none'`,
        2000,
      ),
    )
    await evaluate<void>(
      host.dock,
      `(() => { const chip = document.querySelector('[data-chip="isolated"]'); if (chip instanceof HTMLElement) chip.click() })()`,
    )
    check(
      'clicking a chip completes the prefix',
      await waitForEval(
        host.dock,
        `(() => {
          const input = document.querySelector('[data-role="omnibox"]')
          return input instanceof HTMLInputElement && input.value === '@isolated '
        })()`,
        2000,
      ),
    )
    await evaluate<void>(
      host.dock,
      `(() => {
        const input = document.querySelector('[data-role="omnibox"]')
        if (!(input instanceof HTMLInputElement)) return
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.blur()
      })()`,
    )
    check(
      'clearing the input brings the controls back',
      await waitForEval(
        host.dock,
        `getComputedStyle(document.querySelector('[data-role="zoom"]')).display !== 'none'`,
        2000,
      ),
    )

    check(
      'sidebar row badges its container',
      await waitForEval(
        host.sidebar,
        `[...document.querySelectorAll('[data-tile-id]')].some((row) => row.querySelector('.row-badge')?.textContent === 'isolated')`,
        4000,
      ),
    )

    // "New workspace" is the third arm of the switcher: empty canvas, saved name,
    // on disk, and it becomes the current workspace.
    const fresh = await evaluate<{ ok: boolean; name?: string; error?: string }>(
      host.sidebar,
      `window.overlayBridge.action({ kind: 'new-workspace' })`,
    )
    check('new workspace accepted', fresh.ok === true && typeof fresh.name === 'string', fresh.error ?? JSON.stringify(fresh))
    check('new workspace clears the canvas', await waitFor(() => host.registry.size === 0, 4000), `tiles=${host.registry.size}`)
    const listedAfterNew = fresh.name === undefined ? [] : await host.store.list()
    check(
      'the new workspace exists on disk and in the list',
      fresh.name !== undefined && listedAfterNew.includes(fresh.name) && host.status().workspace === fresh.name,
      `${String(fresh.name)} in ${listedAfterNew.join(',')} current=${host.status().workspace}`,
    )

    // 30. Group frames, the selection ring, free corner resizing and the
    //     workspace file operations. Section 29 left a fresh, empty workspace, so
    //     this starts from a known canvas.
    const frameSeedA = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'create', input: 'data:text/html,%3Ctitle%3EFrame%20A%3C/title%3E' })`,
    )
    const frameSeedB = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'create', input: 'data:text/html,%3Ctitle%3EFrame%20B%3C/title%3E' })`,
    )
    check(
      'two tiles seeded for the frame checks',
      frameSeedA.ok === true && frameSeedB.ok === true,
      frameSeedA.error ?? frameSeedB.error ?? `tiles=${host.registry.size}`,
    )
    await waitFor(() => host.registry.size === 2, 4000)

    // ⌘G frames the selection when there is one, so "around every tile" is now the
    // empty-selection answer. Escape clears what the spawn selected, which is what
    // makes this section test the fallback rather than one tile.
    await evaluate<void>(
      host.canvas,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), undefined`,
    )
    check(
      'Escape clears the selection a spawn left behind',
      await waitForEval(host.canvas, `document.querySelectorAll('.tile-selected').length === 0`, 2000),
    )

    await evaluate<void>(
      host.canvas,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', metaKey: true, bubbles: true })), undefined`,
    )
    check(
      '⌘G draws a frame around the tiles',
      await waitForEval(host.canvas, `document.querySelectorAll('.frame').length === 1`, 3000),
    )
    check(
      'the frame carries its name in an editable header',
      await waitForEval(
        host.canvas,
        `(document.querySelector('.frame [data-role="name"]')?.textContent ?? '') === 'Frame 1'`,
        2000,
      ),
    )

    const zoneSaved = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'save', name: 'frame-check' })`,
    )
    check('frame workspace saved', zoneSaved.ok === true, zoneSaved.error ?? '')
    const zoneState = await host.store.load('frame-check')
    check(
      'the frame serializes into the workspace file',
      zoneState?.frames?.length === 1 &&
        zoneState.frames[0]?.name === 'Frame 1' &&
        (zoneState.frames[0]?.worldW ?? 0) > 0 &&
        (zoneState.frames[0]?.worldH ?? 0) > 0 &&
        // Two 760-wide tiles in a row: a frame around both is at least 1520 wide.
        // This is the empty-selection case, so it must cover both of them.
        (zoneState.frames[0]?.worldW ?? 0) > 1400,
      JSON.stringify(zoneState?.frames ?? null),
    )

    // 30b. Dragging the frame header carries the tiles whose centres it holds.
    //      Zoom is 1 here, so a screen delta is a world delta.
    const carriedIds = host.registry.ids.slice(0, 2)
    const draggedTile = carriedIds[0] ?? null
    const boxOf = (id: string): Promise<Rect | null> =>
      evaluate<Rect | null>(
        host.canvas,
        `(() => {
          const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(id)})
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
        })()`,
      )
    // Both tiles must have been through one layout frame before anything is
    // measured: registry.size counts views, not painted DOM.
    await wait(200)
    const boxBefore = new Map<string, Rect | null>()
    for (const id of carriedIds) boxBefore.set(id, await boxOf(id))
    const viewBeforeCarry = draggedTile === null ? null : host.registry.boundsOf(draggedTile)

    const frameDrag = await evaluate<boolean>(
      host.canvas,
      `(() => {
        const frame = document.querySelector('.frame')
        const head = frame?.querySelector('[data-role="head"]')
        if (!frame || !head) return false
        const bar = head.getBoundingClientRect()
        const x = bar.x + bar.width / 2
        const y = bar.y + bar.height / 2
        head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 51, clientX: x, clientY: y }))
        for (const step of [0.25, 0.5, 0.75, 1]) {
          frame.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 51, clientX: x + 120 * step, clientY: y + 80 * step }))
        }
        frame.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 51, clientX: x + 120, clientY: y + 80 }))
        return true
      })()`,
    )
    check('frame header drag dispatched', frameDrag === true)
    await wait(300)
    const boxAfter = new Map<string, Rect | null>()
    for (const id of carriedIds) boxAfter.set(id, await boxOf(id))
    const viewAfterCarry = draggedTile === null ? null : host.registry.boundsOf(draggedTile)

    const deltas = carriedIds.map((id) => {
      const from = boxBefore.get(id) ?? null
      const to = boxAfter.get(id) ?? null
      if (!from || !to) return null
      return { dx: to.x - from.x, dy: to.y - from.y, width: to.width }
    })
    check(
      'dragging the frame carries every tile it contains by the same offset',
      carriedIds.length === 2 &&
        deltas.every((delta) => delta !== null && Math.abs(delta.dx - 120) <= 2 && Math.abs(delta.dy - 80) <= 2),
      `deltas ${deltas.map((delta) => (delta ? `${delta.dx},${delta.dy}` : 'missing')).join(' | ')} before=${JSON.stringify(
        carriedIds.map((id) => boxBefore.get(id) ?? null),
      )} after=${JSON.stringify(carriedIds.map((id) => boxAfter.get(id) ?? null))}`,
    )
    check(
      'a carried tile keeps its size',
      deltas.every(
        (delta, index) =>
          delta !== null && boxBefore.get(carriedIds[index] ?? '')?.width === delta.width,
      ),
      `widths ${deltas.map((delta) => String(delta?.width)).join(' | ')}`,
    )
    check(
      'the native view follows the carried tile',
      viewBeforeCarry !== null &&
        viewAfterCarry !== null &&
        Math.abs(viewAfterCarry.x - viewBeforeCarry.x - 120) <= 2 &&
        Math.abs(viewAfterCarry.y - viewBeforeCarry.y - 80) <= 2,
      `${JSON.stringify(viewBeforeCarry)} -> ${JSON.stringify(viewAfterCarry)}`,
    )

    // 30c. The selection ring and its four grips, read from computed style: a
    //      class on the node proves nothing about what is painted.
    const ring = await evaluate<{ outline: string; offset: string; grips: number; visible: number }>(
      host.canvas,
      `(() => {
        const tile = document.querySelector('.tile')
        if (!(tile instanceof HTMLElement)) return { outline: 'none', offset: '', grips: 0, visible: 0 }
        tile.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
        const style = getComputedStyle(tile)
        const grips = [...tile.querySelectorAll('[data-role="corner"]')]
        return {
          outline: style.outlineStyle,
          offset: style.outlineOffset,
          grips: grips.length,
          visible: grips.filter((grip) => getComputedStyle(grip).display !== 'none').length,
        }
      })()`,
    )
    check(
      'the selected tile wears a dashed ring offset from its edge',
      ring.outline === 'dashed' && ring.offset === '3px',
      JSON.stringify(ring),
    )
    check(
      'all four corner grips are visible on the selected tile',
      ring.grips === 4 && ring.visible === 4,
      JSON.stringify(ring),
    )

    // 30d. Resizing from the south-east corner moves that edge on both axes, and
    //      the native view has to land on the same rect as the DOM frame.
    const sizeBefore = await evaluate<Rect | null>(
      host.canvas,
      `(() => {
        const tile = document.querySelector('.tile-selected')
        if (!(tile instanceof HTMLElement)) return null
        const r = tile.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      })()`,
    )
    const viewSizeBefore = draggedTile === null ? null : host.registry.boundsOf(draggedTile)
    const cornerDrag = await evaluate<boolean>(
      host.canvas,
      `(() => {
        const tile = document.querySelector('.tile-selected')
        const grip = tile?.querySelector('[data-corner="se"]')
        if (!tile || !grip) return false
        const box = tile.getBoundingClientRect()
        const x = box.right
        const y = box.bottom
        grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 61, clientX: x, clientY: y }))
        for (const step of [0.25, 0.5, 0.75, 1]) {
          tile.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 61, clientX: x + 60 * step, clientY: y + 40 * step }))
        }
        tile.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 61, clientX: x + 60, clientY: y + 40 }))
        return true
      })()`,
    )
    check('corner grip drag dispatched', cornerDrag === true)
    await wait(300)
    const sizeAfter = await evaluate<Rect | null>(
      host.canvas,
      `(() => {
        const tile = document.querySelector('.tile-selected')
        if (!(tile instanceof HTMLElement)) return null
        const r = tile.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      })()`,
    )
    const viewSizeAfter = draggedTile === null ? null : host.registry.boundsOf(draggedTile)
    check(
      'the corner grip resizes both dimensions',
      sizeBefore !== null &&
        sizeAfter !== null &&
        Math.abs(sizeAfter.width - sizeBefore.width - 60) <= 2 &&
        Math.abs(sizeAfter.height - sizeBefore.height - 40) <= 2,
      `${sizeBefore?.width}x${sizeBefore?.height} -> ${sizeAfter?.width}x${sizeAfter?.height}`,
    )
    check(
      'the anchored corner did not move',
      sizeBefore !== null && sizeAfter !== null && Math.abs(sizeAfter.x - sizeBefore.x) <= 1 && Math.abs(sizeAfter.y - sizeBefore.y) <= 1,
      `${sizeBefore?.x},${sizeBefore?.y} -> ${sizeAfter?.x},${sizeAfter?.y}`,
    )
    check(
      'the native view bounds follow the resize in both dimensions',
      viewSizeBefore !== null &&
        viewSizeAfter !== null &&
        Math.abs(viewSizeAfter.width - viewSizeBefore.width - 60) <= 2 &&
        Math.abs(viewSizeAfter.height - viewSizeBefore.height - 40) <= 2,
      `${viewSizeBefore?.width}x${viewSizeBefore?.height} -> ${viewSizeAfter?.width}x${viewSizeAfter?.height}`,
    )

    // 30e. Workspace file operations: duplicate, rename, delete.
    const duplicate = await evaluate<{ ok: boolean; name?: string; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'duplicate-workspace', name: 'frame-check' })`,
    )
    check(
      'duplicating a workspace switches to the copy',
      duplicate.ok === true && duplicate.name === 'frame-check-copy' && host.status().workspace === 'frame-check-copy',
      JSON.stringify(duplicate),
    )
    const duplicateState = await host.store.load('frame-check-copy')
    const originalState = await host.store.load('frame-check')
    check(
      'the duplicate is a second file holding the same canvas',
      duplicateState !== null &&
        originalState !== null &&
        JSON.stringify(duplicateState.tiles) === JSON.stringify(originalState.tiles) &&
        JSON.stringify(duplicateState.frames) === JSON.stringify(originalState.frames),
      `tiles=${duplicateState?.tiles.length} frames=${duplicateState?.frames?.length}`,
    )

    const renamed = await evaluate<{ ok: boolean; name?: string; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'rename-workspace', name: 'frame-check-copy', next: 'frame-renamed' })`,
    )
    check('renaming writes the new name', renamed.ok === true && renamed.name === 'frame-renamed', JSON.stringify(renamed))
    check(
      'the rename removed the old file',
      (await host.store.exists('frame-renamed')) === true && (await host.store.exists('frame-check-copy')) === false,
      (await host.store.list()).join(','),
    )

    const deleted = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'delete-workspace', name: 'frame-renamed' })`,
    )
    check(
      'deleting a workspace unlinks its file',
      deleted.ok === true && (await host.store.exists('frame-renamed')) === false,
      deleted.error ?? (await host.store.list()).join(','),
    )

    // 30f. A zone has to come off the canvas again: ⌘G is one keystroke away, and
    //      a frame without a ✕ would only be removable by editing the JSON.
    await evaluate<void>(
      host.canvas,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', metaKey: true, bubbles: true })), undefined`,
    )
    await waitForEval(host.canvas, `document.querySelectorAll('.frame').length >= 1`, 2000)
    const zonesBefore = await evaluate<number>(host.canvas, `document.querySelectorAll('.frame').length`)
    const closeZone = await evaluate<boolean>(
      host.canvas,
      `(() => {
        const button = document.querySelector('.frame [data-role="close"]')
        if (!(button instanceof HTMLElement)) return false
        button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
        button.click()
        return true
      })()`,
    )
    check('the frame header carries a remove button', closeZone === true, `frames=${zonesBefore}`)
    check(
      'pressing it drops the zone from the canvas',
      await waitForEval(host.canvas, `document.querySelectorAll('.frame').length === ${zonesBefore - 1}`, 2000),
    )

    // 30g. The menu's buttons are wired to the same actions the bridge exposes —
    //      asserted through a real click, not by calling the action directly.
    const listBeforeUi = (await host.store.list()).length
    const menuUi = await evaluate<boolean>(
      host.sidebar,
      `(() => {
        const picker = document.querySelector('[data-role="ws-picker"]')
        if (!(picker instanceof HTMLElement)) return false
        picker.click()
        const duplicate = document.querySelector('[data-ws-action="duplicate"]')
        if (!(duplicate instanceof HTMLElement)) return false
        duplicate.click()
        return true
      })()`,
    )
    check('the workspace menu exposes its file actions', menuUi === true)
    let uiList = await host.store.list()
    const uiDeadline = Date.now() + 5000
    while (uiList.length === listBeforeUi && Date.now() < uiDeadline) {
      await wait(80)
      uiList = await host.store.list()
    }
    check(
      'duplicate from the menu writes a second workspace',
      uiList.length === listBeforeUi + 1,
      `${listBeforeUi} -> ${uiList.join(',')}`,
    )

    // 30h. Multi-select and frame colour. Selection is a set now, so the checks
    //      are: two presses select two tiles, a rubberband picks the same two, ⌘G
    //      frames only those two, and a swatch reaches both the CSS property and
    //      the saved file. Every assertion reads state that outlives the gesture —
    //      the DOM classes, the registry, the workspace JSON — never a handler's
    //      own bookkeeping.
    const freshWorkspace = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'new-workspace' })`,
    )
    check('a fresh workspace for the selection checks', freshWorkspace.ok === true, freshWorkspace.error ?? '')
    await waitFor(() => host.registry.size === 0, 3000)

    let seeded = 0
    for (let index = 0; index < 3; index += 1) {
      seeded += 1
      const born = await evaluate<{ ok: boolean; error?: string }>(
        host.overlay,
        `window.overlayBridge.action({ kind: 'create', input: 'about:blank' })`,
      )
      if (!born.ok) check(`spawn ${index + 1} for the selection checks`, false, born.error ?? '')
      await waitFor(() => host.registry.size === seeded, 3000)
    }
    check('three tiles seeded for the selection checks', host.registry.size === 3, `tiles=${host.registry.size}`)

    const clickPair = await evaluate<boolean>(
      host.canvas,
      `(() => {
        const tiles = [...document.querySelectorAll('.tile')]
        if (tiles.length < 3) return false
        tiles[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 71 }))
        tiles[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 72, shiftKey: true }))
        return true
      })()`,
    )
    check('a plain press and a shift press were dispatched', clickPair === true)
    check(
      'shift-click leaves exactly two tiles selected',
      await waitForEval(host.canvas, `document.querySelectorAll('.tile-selected').length === 2`),
      `${await evaluate<number>(host.canvas, `document.querySelectorAll('.tile-selected').length`)} selected`,
    )
    const selectedIds = await evaluate<string[]>(
      host.canvas,
      `[...document.querySelectorAll('.tile-selected')].map((el) => el.dataset.tileId ?? '')`,
    )

    const savedSelection = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'save', name: 'selection-check' })`,
    )
    check('the selection workspace saved', savedSelection.ok === true, savedSelection.error ?? '')
    const worldTiles = (await host.store.load('selection-check'))?.tiles ?? []

    // The rubberband covers the first two tiles: the box is *inset* from their
    // union by 3px, never expanded. Cascaded tiles land flush against each other,
    // so a box that overshoots by even a pixel would also select the neighbour —
    // a real trap, and the reason this draws inside the union rather than around it.
    const rubberband = await evaluate<boolean>(
      host.canvas,
      `(() => {
        const tiles = [...document.querySelectorAll('.tile')]
        if (tiles.length < 3) return false
        const a = tiles[0].getBoundingClientRect()
        const b = tiles[1].getBoundingClientRect()
        const inset = 3
        const x0 = Math.min(a.left, b.left) + inset
        const y0 = Math.min(a.top, b.top) + inset
        const x1 = Math.max(a.right, b.right) - inset
        const y1 = Math.max(a.bottom, b.bottom) - inset
        const canvas = document.getElementById('canvas')
        if (!canvas) return false
        canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 80, clientX: x0, clientY: y0 }))
        for (const step of [0.34, 0.67, 1]) {
          canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 80, clientX: x0 + (x1 - x0) * step, clientY: y0 + (y1 - y0) * step }))
        }
        canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 80, clientX: x1, clientY: y1 }))
        return true
      })()`,
    )
    check('a rubberband drag was dispatched over the first two tiles', rubberband === true)
    check(
      'the rubberband selects the tiles it covers',
      await waitForEval(host.canvas, `document.querySelectorAll('.tile-selected').length === 2`),
      `${await evaluate<number>(host.canvas, `document.querySelectorAll('.tile-selected').length`)} selected`,
    )
    check(
      'the rubberband box is hidden again after release',
      await waitForEval(host.canvas, `document.getElementById('selection-marquee')?.hidden === true`),
    )
    const marqueeSelection = await evaluate<string[]>(
      host.canvas,
      `[...document.querySelectorAll('.tile-selected')].map((el) => el.dataset.tileId ?? '')`,
    )
    check(
      'the rubberband picked the same two tiles the shift-click did',
      marqueeSelection.length === 2 && marqueeSelection.every((id) => selectedIds.includes(id)),
      `${marqueeSelection.join(',')} vs ${selectedIds.join(',')}`,
    )

    // ⌘G over a subset: the frame must bound those two and leave the third out.
    const framesBefore = await evaluate<number>(host.canvas, `document.querySelectorAll('.frame').length`)
    await evaluate<void>(
      host.canvas,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', metaKey: true, bubbles: true })), undefined`,
    )
    check(
      '⌘G draws a frame while two tiles are selected',
      await waitForEval(host.canvas, `document.querySelectorAll('.frame').length === ${framesBefore + 1}`, 2000),
    )
    const savedFrame = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'save', name: 'selection-check' })`,
    )
    check('the framed workspace saved', savedFrame.ok === true, savedFrame.error ?? '')
    const framed = await host.store.load('selection-check')
    const frame = framed?.frames?.[0] ?? null
    const picked = worldTiles.filter((tile) => marqueeSelection.includes(tile.id))
    const union = picked.reduce(
      (acc, tile) => ({
        minX: Math.min(acc.minX, tile.world.x),
        minY: Math.min(acc.minY, tile.world.y),
        maxX: Math.max(acc.maxX, tile.world.x + tile.world.width),
        maxY: Math.max(acc.maxY, tile.world.y + tile.world.height),
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    )
    const expected = {
      x: union.minX - FRAME_PADDING_WORLD,
      y: union.minY - FRAME_PADDING_WORLD,
      width: union.maxX - union.minX + FRAME_PADDING_WORLD * 2,
      height: union.maxY - union.minY + FRAME_PADDING_WORLD * 2,
    }
    check(
      'the frame is sized to the selected tiles plus the padding, not the whole canvas',
      frame !== null &&
        Math.abs(frame.worldX - expected.x) <= 1 &&
        Math.abs(frame.worldY - expected.y) <= 1 &&
        Math.abs(frame.worldW - expected.width) <= 1 &&
        Math.abs(frame.worldH - expected.height) <= 1,
      `frame=${JSON.stringify(frame)} expected=${JSON.stringify(expected)} picked=${picked.length}/${worldTiles.length}`,
    )
    // "Only those two" is asserted on the rule that decides it: a frame carries the
    // tiles whose *centre* it holds. Intersection would be the wrong test — the
    // 48px padding always overlaps the edge of a tile sitting flush beside the
    // selection, so an overlapping edge proves nothing.
    const outsider = worldTiles.find((tile) => !marqueeSelection.includes(tile.id)) ?? null
    check(
      'the unselected tile is not one the frame would carry',
      frame !== null &&
        outsider !== null &&
        !containsPoint(
          { x: frame.worldX, y: frame.worldY, width: frame.worldW, height: frame.worldH },
          {
            x: outsider.world.x + outsider.world.width / 2,
            y: outsider.world.y + outsider.world.height / 2,
          },
        ),
      outsider === null ? 'no unselected tile to compare' : `outsider=${outsider.id}`,
    )

    // A swatch is the writer FrameRecord.color never had. Asserted three ways: the
    // property the stylesheet reads, the inline style the tint comes from, and the
    // saved file — the last one is what survives a restart.
    const tint = FRAME_COLORS[1] ?? '#5b8fd6'
    const pickedSwatch = await evaluate<boolean>(
      host.canvas,
      `(() => {
        const zone = document.querySelector('.frame')
        if (!(zone instanceof HTMLElement)) return false
        const dot = zone.querySelector('[data-role="color"]')
        if (!(dot instanceof HTMLElement)) return false
        dot.click()
        const swatch = zone.querySelector('[data-color="${tint}"]')
        if (!(swatch instanceof HTMLElement)) return false
        swatch.click()
        return true
      })()`,
    )
    check('the frame header opens its swatch row and a tint is pressable', pickedSwatch === true)
    check(
      'the tint reaches the custom property the stylesheet paints from',
      await waitForEval(
        host.canvas,
        `document.querySelector('.frame')?.style.getPropertyValue('--frame-color').trim() === '${tint}'`,
      ),
    )
    const swatchSaved = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'save', name: 'selection-check' })`,
    )
    const withColour = await host.store.load('selection-check')
    check(
      'the chosen colour is written into the saved workspace',
      swatchSaved.ok === true && withColour?.frames?.[0]?.color === tint,
      JSON.stringify(withColour?.frames?.[0] ?? null),
    )

    // The row must clear the topmost tile's title bar: a zone's tiles begin exactly
    // FRAME_PADDING_WORLD below its top edge and the tile layer paints above
    // #frames, so an overlap is a control that cannot be pressed at 1x. Measuring
    // it needs the row open — a hidden element has no box — so it is reopened for
    // the measurement and closed again, leaving the zone as it was found.
    const rowClearance = await evaluate<{ overlaps: boolean; row: string; tiles: number }>(
      host.canvas,
      `(() => {
        const zone = document.querySelector('.frame')
        const row = zone?.querySelector('[data-role="swatches"]')
        const dot = zone?.querySelector('[data-role="color"]')
        if (!(row instanceof HTMLElement) || !(dot instanceof HTMLElement)) {
          return { overlaps: true, row: 'missing', tiles: 0 }
        }
        const wasHidden = row.hidden
        if (wasHidden) dot.click()
        const r = row.getBoundingClientRect()
        const hits = [...document.querySelectorAll('.tile')].filter((tile) => {
          const t = tile.getBoundingClientRect()
          return t.left < r.right && r.left < t.right && t.top < r.bottom && r.top < t.bottom
        }).length
        const measurement = \`\${Math.round(r.top)}..\${Math.round(r.bottom)} h=\${Math.round(r.height)}\`
        if (wasHidden) dot.click()
        return { overlaps: hits > 0, row: measurement, tiles: hits }
      })()`,
    )
    check(
      'the swatch row clears the top-most tile’s title bar',
      rowClearance.overlaps === false,
      `${rowClearance.row} overlappingTiles=${rowClearance.tiles}`,
    )

    // 30i. Theming. Four things have to hold: the canvas paints a gradient before any
    //      workspace is touched, a control moved in the inspector reaches *both*
    //      documents, a save writes the theme, and a workspace without one drops the
    //      custom properties back to the default rather than keeping the last theme.
    const gradientAtBoot = await evaluate<string>(
      host.canvas,
      `getComputedStyle(document.getElementById('canvas')).backgroundImage`,
    )
    check(
      'the canvas paints a theme gradient on startup',
      gradientAtBoot.includes('linear-gradient'),
      gradientAtBoot.slice(0, 72),
    )

    // The inspector lives in the sidebar view, in flow under its header.
    const opened = await evaluate<boolean>(
      host.sidebar,
      `(() => {
        const button = document.querySelector('[data-role="theme"]')
        if (!(button instanceof HTMLElement)) return false
        button.click()
        const panel = document.querySelector('[data-role="theme-panel"]')
        return panel instanceof HTMLElement && !panel.hidden
      })()`,
    )
    check('the sidebar opens the theme inspector in flow', opened === true)

    // A generated harmony, then a hue move: the palette is re-derived, so --theme-base
    // has to change on the canvas and land in the sidebar's own document too.
    const movedHue = await evaluate<boolean>(
      host.sidebar,
      `(() => {
        const triad = document.querySelector('[data-harmony="triad"]')
        if (!(triad instanceof HTMLElement)) return false
        triad.click()
        const hue = document.querySelector('[data-theme="baseHue"]')
        if (!(hue instanceof HTMLInputElement)) return false
        hue.value = '12'
        hue.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`,
    )
    check('the inspector moves the hue and derives a new palette', movedHue === true)
    const canvasBase = await waitForEval(
      host.canvas,
      `getComputedStyle(document.getElementById('canvas')).getPropertyValue('--theme-base').trim().length === 7`,
      2000,
    )
    check('the canvas root takes the derived base colour', canvasBase === true)
    const deepEqualBases = await evaluate<{ canvas: string; sidebar: string; dock: string }>(
      host.canvas,
      `({ canvas: getComputedStyle(document.getElementById('canvas')).getPropertyValue('--theme-base').trim(), sidebar: '', dock: '' })`,
    )
    const sidebarBase = await evaluate<string>(
      host.sidebar,
      `getComputedStyle(document.documentElement).getPropertyValue('--theme-base').trim()`,
    )
    const dockBase = await evaluate<string>(
      host.dock,
      `getComputedStyle(document.documentElement).getPropertyValue('--theme-base').trim()`,
    )
    check(
      'one broadcast reaches the canvas and both chrome views',
      deepEqualBases.canvas.length === 7 && sidebarBase === deepEqualBases.canvas && dockBase === deepEqualBases.canvas,
      `canvas=${deepEqualBases.canvas} sidebar=${sidebarBase} dock=${dockBase}`,
    )
    const tintedSidebar = await evaluate<string>(
      host.sidebar,
      `getComputedStyle(document.querySelector('.sidebar')).getPropertyValue('background-color')`,
    )
    check(
      'the sidebar wears a tint mixed from the theme',
      tintedSidebar.startsWith('color(') || tintedSidebar.startsWith('rgb'),
      tintedSidebar,
    )

    const themedSave = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'save', name: 'themed-check' })`,
    )
    check('the themed workspace saved', themedSave.ok === true, themedSave.error ?? '')
    const savedTheme = (await host.store.load('themed-check'))?.theme ?? null
    check(
      'the saved file carries a theme whose stops are all hex',
      savedTheme !== null &&
        savedTheme.colors.length >= 2 &&
        savedTheme.colors.length <= 4 &&
        savedTheme.colors.every((color: string) => /^#[0-9a-f]{6}$/.test(color)) &&
        savedTheme.harmony === 'triad' &&
        savedTheme.baseHue === 12,
      JSON.stringify(savedTheme),
    )

    // An unthemed workspace must clear the properties, not inherit the last palette.
    const freshUnthemed = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'new-workspace' })`,
    )
    check('a fresh unthemed workspace opened', freshUnthemed.ok === true, freshUnthemed.error ?? '')
    const resetBase = await waitForEval(
      host.canvas,
      `getComputedStyle(document.getElementById('canvas')).getPropertyValue('--theme-base').trim() === '#121620'`,
      3000,
    )
    check('switching to an unthemed workspace restores the default stops', resetBase === true)
    const resetEcho = await evaluate<string>(
      host.sidebar,
      `getComputedStyle(document.documentElement).getPropertyValue('--theme-base').trim()`,
    )
    check('the chrome followed the reset', resetEcho === '#121620', resetEcho)

    // 30j. Cosmetic filtering. The network blocklist cancels the requests, so what is
    //      left on the page is the container. Served from loopback so this is a test of
    //      the injection rather than of the network, then paused to watch it come back.
    const cosmeticStats = host.cosmetic()
    check(
      'cosmetic: the rule list loaded',
      cosmeticStats.generic >= 10 && cosmeticStats.hosts >= 1,
      `${cosmeticStats.generic} generic, ${cosmeticStats.hosts} host set(s)`,
    )

    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><title>Cosmetic</title><div class="ad-slot" id="ad">AD</div><div id="keep">KEEP</div>',
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const origin = `http://127.0.0.1:${port}/`

    /** The probe page is the only document on this origin, so URL identifies it. */
    const probeDisplay = async (selector: string): Promise<string> => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(origin))
      if (!target) return 'missing'
      try {
        return (await target.executeJavaScript(
          `getComputedStyle(document.querySelector('${selector}')).display`,
          true,
        )) as string
      } catch {
        return 'missing'
      }
    }
    const waitForDisplay = async (selector: string, expected: string, timeoutMs = 5000): Promise<string> => {
      const deadline = Date.now() + timeoutMs
      let seen = 'missing'
      while (Date.now() < deadline) {
        seen = await probeDisplay(selector)
        if (seen === expected) return seen
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
      return seen
    }

    // The canvas empties the deck asynchronously: `new-workspace` above is an RPC the canvas
    // applies, so a tile count read here can still be the *previous* workspace's. Capturing it
    // late makes the teardown check below wait for tiles that are already gone — an intermittent
    // red with `0 vs 3` that has nothing to do with cosmetic filtering.
    const deckEmpty = await waitFor(() => host.inventory().length === 0, 3000)
    check('the fresh workspace arrived empty', deckEmpty, `${host.inventory().length} tile(s)`)
    const tilesBeforeCosmetic = host.inventory().length
    const cosmeticCreate = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'create', input: '${origin}' })`,
    )
    check('cosmetic: a loopback page opened', cosmeticCreate.ok === true, cosmeticCreate.error ?? '')

    const adHidden = await waitForDisplay('#ad', 'none')
    check('the ad container is hidden by injected CSS', adHidden === 'none', `display=${adHidden}`)
    const keepShown = await probeDisplay('#keep')
    check('content the rules do not name is untouched', keepShown === 'block', `display=${keepShown}`)

    const filteredRow = host.chromeTiles().find((tile) => tile.url === origin)
    check(
      'the sidebar is told this host has rules and is filtered',
      filteredRow?.cosmetic === true && filteredRow?.paused === false,
      JSON.stringify(filteredRow ?? null),
    )
    // …and the row actually draws the control from it. A collapsed sidebar renders no
    // rows, so open it if the button is not there; this is the last section, so leaving
    // it open costs nothing.
    const shieldCount = (): Promise<number> =>
      evaluate<number>(host.sidebar, `document.querySelectorAll('.row-cosmetic').length`)
    if ((await shieldCount()) === 0) {
      await evaluate<unknown>(host.overlay, `window.overlayBridge.action({ kind: 'toggle-sidebar' })`)
    }
    const shieldShown = await waitForEval(host.sidebar, `document.querySelectorAll('.row-cosmetic').length >= 1`)
    check('the row shows a shield for a filtered host', shieldShown === true)

    const pausedAction = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'toggle-cosmetic', host: '127.0.0.1' })`,
    )
    check('cosmetic: pausing a host is accepted', pausedAction.ok === true, pausedAction.error ?? '')
    const adBack = await waitForDisplay('#ad', 'block')
    check('pausing brings the container back on the page already open', adBack === 'block', `display=${adBack}`)

    const pausedSession = await host.store.session()
    check(
      'the pause is written to session.json',
      (pausedSession.cosmeticPaused ?? []).includes('127.0.0.1'),
      JSON.stringify(pausedSession.cosmeticPaused ?? []),
    )
    check('main reports one paused host', host.cosmetic().paused === 1, String(host.cosmetic().paused))
    const pausedRow = host.chromeTiles().find((tile) => tile.url === origin)
    check(
      'the row reports the pause',
      pausedRow?.cosmetic === true && pausedRow?.paused === true,
      JSON.stringify(pausedRow ?? null),
    )
    const shieldDimmed = await waitForEval(
      host.sidebar,
      `(() => { const b = document.querySelector('.row-cosmetic'); return b !== null && b.classList.contains('off') })()`,
    )
    check('the shield shows the paused state, not just an internal flag', shieldDimmed === true)

    const resumedAction = await evaluate<{ ok: boolean; error?: string }>(
      host.overlay,
      `window.overlayBridge.action({ kind: 'toggle-cosmetic', host: '127.0.0.1' })`,
    )
    check('cosmetic: resuming a host is accepted', resumedAction.ok === true, resumedAction.error ?? '')
    const adHiddenAgain = await waitForDisplay('#ad', 'none')
    check('resuming hides the container again', adHiddenAgain === 'none', `display=${adHiddenAgain}`)
    check('the pause list is empty again', host.cosmetic().paused === 0, String(host.cosmetic().paused))

    // Close the probe page and the server: a later section must not see either.
    const probeTile = host.inventory().find((tile) => tile.url === origin)
    if (probeTile) {
      await evaluate<void>(host.overlay, `window.overlayBridge.action({ kind: 'tile-close', id: '${probeTile.id}' })`)
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const probeGone = await waitFor(() => host.inventory().length === tilesBeforeCosmetic, 3000)
    check('cosmetic: the probe page and its server are gone', probeGone, `${host.inventory().length} vs ${tilesBeforeCosmetic}`)

    // 31. Layer order. Click-to-raise is one entry point into the paint order and the
    //     sidebar's layer panel is the other. Both are checked against three
    //     representations that are supposed to agree and can each be wrong alone: the
    //     canvas DOM's computed z-index, the native child-view stack
    //     (`host.viewOrder()`), and the inventory the chrome was pushed.
    interface LayerRow {
      id: string
      front: boolean
      back: boolean
    }

    /** Tile ids from the canvas DOM, back to front (ascending computed z-index). */
    const domOrder = async (): Promise<string[]> => {
      const rows = await evaluate<Array<{ id: string; z: number }>>(
        host.canvas,
        `(() => [...document.querySelectorAll('.tile')]
          .map((el) => ({ id: el.dataset.tileId, z: Number(getComputedStyle(el).zIndex) || 0 }))
          .sort((a, b) => a.z - b.z))()`,
      )
      return rows.map((row) => row.id)
    }

    /** Tile ids as the chrome was told them, back to front. */
    const inventoryOrder = (): string[] =>
      [...host.inventory()]
        .sort((left, right) => left.layer - right.layer)
        .map((tile) => tile.id)

    const orderAgrees = async (): Promise<{ ok: boolean; dom: string; views: string; rows: string }> => {
      const dom = await domOrder()
      const views = host.viewOrder()
      const rows = inventoryOrder()
      return {
        ok:
          dom.length > 0 &&
          dom.join(',') === views.join(',') &&
          views.join(',') === rows.join(','),
        dom: dom.join(','),
        views: views.join(','),
        rows: rows.join(','),
      }
    }

    /** Poll for all three representations reading exactly `expected`, back to front. */
    const waitOrder = async (expected: string[], timeoutMs = 4000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const order = await orderAgrees()
        if (order.ok && order.dom === expected.join(',')) return true
        if (Date.now() > deadline) return false
        await wait(60)
      }
    }

    /** A press on the title bar, through the same synthetic pipeline the drag checks use. */
    const pressTile = async (id: string): Promise<boolean> => {
      const pressed = await evaluate<boolean>(
        host.canvas,
        `(() => {
          const self = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(id)})
          if (!self) return false
          const chrome = self.querySelector('.tile-chrome')
          const bar = chrome.getBoundingClientRect()
          const x = bar.x + 60
          const y = bar.y + Math.min(bar.height, 20) / 2
          chrome.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 43, clientX: x, clientY: y }))
          self.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 43, clientX: x, clientY: y }))
          return true
        })()`,
      )
      await wait(200)
      return pressed
    }

    const task = (input: string): Promise<{ ok: boolean; name?: string; error?: string }> =>
      evaluate<{ ok: boolean; name?: string; error?: string }>(
        host.overlay,
        `window.overlayBridge.action(${input})`,
      )

    const layerWs = await task(`{ kind: 'new-workspace' }`)
    check(
      'layer order: a fresh workspace to order',
      layerWs.ok === true && typeof layerWs.name === 'string',
      layerWs.error ?? '',
    )
    const layerName = layerWs.name ?? ''
    await waitFor(() => host.inventory().length === 0, 3000)

    // A data: page per tile, so nothing here touches the network and each tile has a
    // distinct title.
    const spawnTagged = (tag: string): Promise<{ ok: boolean; error?: string }> =>
      task(
        `{ kind: 'create', input: ${JSON.stringify(
          `data:text/html,${encodeURIComponent(
            `<!doctype html><title>Layer ${tag}</title><body style="margin:0">${tag}</body>`,
          )}`,
        )} }`,
      )
    const spawned = [await spawnTagged('one'), await spawnTagged('two'), await spawnTagged('three')]
    check(
      'layer order: three tiles to order',
      spawned.every((result) => result.ok === true) && (await waitFor(() => host.inventory().length === 3, 4000)),
      `tiles=${host.inventory().length}`,
    )

    // The inventory is pushed in creation order (a raise must not reorder it), so it
    // is also the creation order this section compares against.
    const layerIds = host.inventory().map((tile) => tile.id)
    const baseline = await orderAgrees()
    check(
      'three representations of the order agree at spawn',
      baseline.ok && baseline.dom === layerIds.join(','),
      JSON.stringify(baseline),
    )

    const layersPushed = host.inventory().map((tile) => tile.layer)
    check(
      'the inventory carries one distinct layer per tile',
      new Set(layersPushed).size === 3,
      JSON.stringify(layersPushed),
    )

    // 31a. A press is the raise. The back tile must end up in front everywhere.
    const backId = layerIds[0]!
    check('layer order: a press reaches the back tile', (await pressTile(backId)) === true)
    const postPressOrder = [...layerIds.slice(1), backId]
    check(
      'a press raises the tile in the DOM, the view stack and the inventory',
      await waitOrder(postPressOrder),
      JSON.stringify(await orderAgrees()),
    )

    // 31b. The panel lists the same order, front to back — the reverse of the model.
    const panelOpened = await evaluate<boolean>(
      host.sidebar,
      `(() => {
        const button = document.querySelector('[data-role="layers"]')
        if (!(button instanceof HTMLElement)) return false
        button.click()
        return true
      })()`,
    )
    check(
      'layer order: the panel opens',
      panelOpened === true && (await waitForEval(host.sidebar, `document.querySelectorAll('.layer-row').length === 3`)),
    )

    const readRows = (): Promise<LayerRow[]> =>
      evaluate<LayerRow[]>(
        host.sidebar,
        `(() => [...document.querySelectorAll('.layer-row')].map((row) => ({
          id: row.dataset.layerId,
          front: row.querySelector('[data-role="layer-front"]').disabled === true,
          back: row.querySelector('[data-role="layer-back"]').disabled === true,
        })))()`,
      )

    const rowsFrontToBack = [...postPressOrder].reverse()
    const listedRows = await readRows()
    check(
      'the panel lists front to back',
      listedRows.map((row) => row.id).join(',') === rowsFrontToBack.join(','),
      listedRows.map((row) => row.id).join(','),
    )
    check(
      'the ends disable the move that would do nothing',
      listedRows[0]?.front === true &&
        listedRows[0]?.back === false &&
        listedRows[2]?.back === true &&
        listedRows[2]?.front === false,
      JSON.stringify(listedRows),
    )

    // 31c. Sending the front tile back is the panel's other control, and it must not
    //      touch geometry: the order and the world rects are separate state.
    const beforeOrderChange = await measureTiles()
    const sentBack = await evaluate<boolean>(
      host.sidebar,
      `(() => {
        const row = document.querySelector('.layer-row')
        const button = row ? row.querySelector('[data-role="layer-back"]') : null
        if (!(button instanceof HTMLElement)) return false
        button.click()
        return true
      })()`,
    )
    check('layer order: the front row can be sent back', sentBack === true && (await waitOrder(layerIds)))
    const afterOrderChange = await measureTiles()
    const geometryHeld =
      beforeOrderChange.length === afterOrderChange.length &&
      beforeOrderChange.every((tile) => {
        const other = afterOrderChange.find((candidate) => candidate.id === tile.id)
        return (
          other !== undefined &&
          other.box.x === tile.box.x &&
          other.box.y === tile.box.y &&
          other.box.width === tile.box.width &&
          other.box.height === tile.box.height
        )
      })
    check('an order change moves nothing on the canvas', geometryHeld, `tiles=${afterOrderChange.length}`)

    // 31d. Persistence. Creation order writes no key; a raise does.
    const savedPlain = await task(`{ kind: 'save', name: ${JSON.stringify(layerName)} }`)
    const plainRaw = JSON.parse(await readFile(host.store.pathFor(layerName), 'utf8')) as { stack?: unknown }
    check(
      'a canvas in creation order writes no layer key',
      savedPlain.ok === true && plainRaw.stack === undefined,
      JSON.stringify(plainRaw.stack ?? null),
    )

    const raised = layerIds[0]!
    check('layer order: a raise to persist', (await pressTile(raised)) === true && (await waitOrder([...layerIds.slice(1), raised])))
    const savedOrdered = await task(`{ kind: 'save', name: ${JSON.stringify(layerName)} }`)
    const orderedRaw = JSON.parse(await readFile(host.store.pathFor(layerName), 'utf8')) as { stack?: unknown }
    const orderedExpectation = [...layerIds.slice(1), raised]
    check(
      'a re-ordered canvas writes its layer order',
      savedOrdered.ok === true &&
        Array.isArray(orderedRaw.stack) &&
        (orderedRaw.stack as string[]).join(',') === orderedExpectation.join(','),
      JSON.stringify(orderedRaw.stack ?? null),
    )

    // 31e. Reload. Switch away and back: the order has to survive the file, which is
    //      the hop a field dropped by a whitelist fails silently.
    const away = await task(`{ kind: 'new-workspace' }`)
    check('layer order: switched away from the ordered workspace', away.ok === true, away.error ?? '')
    await waitFor(() => host.inventory().length === 0, 3000)
    const restored = await task(`{ kind: 'switch', name: ${JSON.stringify(layerName)} }`)
    check(
      'reloading the workspace restores its order',
      restored.ok === true && (await waitOrder(orderedExpectation)),
      restored.error ?? JSON.stringify(await orderAgrees()),
    )
    const rowsAfterReload = await readRows()
    check(
      'the panel shows the restored order',
      rowsAfterReload.map((row) => row.id).join(',') === [...orderedExpectation].reverse().join(','),
      rowsAfterReload.map((row) => row.id).join(','),
    )

    // 31e-bis. A row press is a press: it raises in both layers and centres the tile,
    //          but it must not change the selection (a row click pans, it does not select).
    const selectionBefore = host
      .inventory()
      .filter((tile) => tile.selected)
      .map((tile) => tile.id)
      .join(',')
    const backRowId = orderedExpectation[0]!
    const rowPressed = await evaluate<boolean>(
      host.sidebar,
      `(() => {
        const rows = [...document.querySelectorAll('.layer-row')]
        const row = rows[rows.length - 1]
        if (!row) return false
        row.click()
        return true
      })()`,
    )
    check(
      'a layer row press raises the tile in both layers and leaves the selection alone',
      rowPressed === true &&
        (await waitOrder([...orderedExpectation.slice(1), backRowId])) &&
        host
          .inventory()
          .filter((tile) => tile.selected)
          .map((tile) => tile.id)
          .join(',') === selectionBefore,
      JSON.stringify(await orderAgrees()),
    )

    // 31f. Duplicate is the other hop that rebuilds a snapshot from a loaded file.
    const duplicated = await task(`{ kind: 'duplicate-workspace', name: ${JSON.stringify(layerName)} }`)
    const copyName = duplicated.name ?? ''
    const copyRaw = copyName
      ? (JSON.parse(await readFile(host.store.pathFor(copyName), 'utf8')) as { stack?: unknown })
      : {}
    check(
      'a copy keeps the layer order and is applied on the canvas',
      duplicated.ok === true &&
        Array.isArray(copyRaw.stack) &&
        (copyRaw.stack as string[]).join(',') === orderedExpectation.join(',') &&
        (await waitOrder(orderedExpectation)),
      duplicated.error ?? JSON.stringify(copyRaw.stack ?? null),
    )

    // 31g. The header is 280px wide and now holds six controls: the workspace picker
    //      still has to be usable, or the new button stole the name.
    const sidebarCollapsed = await evaluate<boolean>(
      host.sidebar,
      `document.querySelector('.sidebar').classList.contains('collapsed')`,
    )
    if (sidebarCollapsed) {
      await task(`{ kind: 'toggle-sidebar' }`)
      await wait(400)
    }
    const pickerWidth = await evaluate<number>(
      host.sidebar,
      `document.querySelector('.ws-picker').getBoundingClientRect().width`,
    )
    check('the header still fits with the layer button', pickerWidth >= 80, `picker=${Math.round(pickerWidth)}px`)

    // 31h. Collapsed, the panel is in flow inside a 44px rail: it has to be hidden by
    //      its own CSS, because main only shrinks the view.
    await task(`{ kind: 'toggle-sidebar' }`)
    await wait(500)
    const rail = await evaluate<{ menu: string; button: string }>(
      host.sidebar,
      `(() => ({
        menu: getComputedStyle(document.querySelector('.layer-menu')).display,
        button: getComputedStyle(document.querySelector('.layer-btn')).display,
      }))()`,
    )
    check(
      'the layer panel does not paint in the collapsed rail',
      rail.menu === 'none' && rail.button === 'none',
      JSON.stringify(rail),
    )
    await task(`{ kind: 'toggle-sidebar' }`)
    await wait(400)

    // 32. Dark mode and the clipper. Both are per-tile actions whose truth lives in main,
    //     so every check here presses the chrome's own button and then reads something
    //     main or the page actually produced: main's flag, the page's computed filter,
    //     the saved workspace file, or the note on disk. A check that only read back the
    //     value the canvas just wrote would pass with the injection stubbed out.
    const darkWs = await task(`{ kind: 'new-workspace' }`)
    check('dark mode: a fresh workspace to darken', darkWs.ok === true, darkWs.error ?? '')
    const darkName = darkWs.name ?? ''
    await waitFor(() => host.inventory().length === 0, 3000)

    const marker = 'MARKER-DARK-CLIP-1789'
    const pageOne = `data:text/html,${encodeURIComponent(
      `<!doctype html><html><head><title>Dark Smoke</title></head><body><p>${marker}</p><p>second line</p></body></html>`,
    )}`
    const madeTile = await task(`{ kind: 'create', input: ${JSON.stringify(pageOne)} }`)
    const subject = host.inventory()[0]?.id ?? ''
    check(
      'dark mode: a tile to toggle',
      madeTile.ok === true && subject.length > 0 && (await waitFor(() => host.inventory().length === 1, 4000)),
      madeTile.error ?? `id=${subject}`,
    )

    /** The two buttons' rendered state, read off the canvas DOM. */
    const chromeState = (): Promise<{ pressed: string | null; active: boolean } | null> =>
      evaluate<{ pressed: string | null; active: boolean } | null>(
        host.canvas,
        `(() => {
          const self = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(subject)})
          const dark = self && self.querySelector('.tile-dark-toggle')
          if (!dark) return null
          return { pressed: dark.getAttribute('aria-pressed'), active: dark.classList.contains('active') }
        })()`,
      )

    /** Press one of this tile's header buttons the way a pointer would. */
    const pressChrome = (selector: string): Promise<boolean> =>
      evaluate<boolean>(
        host.canvas,
        `(() => {
          const self = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(subject)})
          const button = self && self.querySelector(${JSON.stringify(selector)})
          if (!button) return false
          button.click()
          return true
        })()`,
      )

    /** The filter a stylesheet would have to be live to produce, read inside the page. */
    const pageFilter = async (): Promise<string> => {
      const contents = host.registry.contentsOf(subject)
      if (!contents) return 'no view'
      try {
        return String(await contents.executeJavaScript(`getComputedStyle(document.documentElement).filter`, true))
      } catch (error) {
        return `refused: ${String(error)}`
      }
    }

    const pageText = async (): Promise<string> => {
      const contents = host.registry.contentsOf(subject)
      if (!contents) return 'no view'
      try {
        return String(await contents.executeJavaScript(`document.body ? document.body.innerText : ''`, true))
      } catch (error) {
        return `refused: ${String(error)}`
      }
    }

    const waitUntil = async (predicate: () => Promise<boolean>, timeoutMs = 4000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (await predicate()) return true
        if (Date.now() > deadline) return false
        await wait(60)
      }
    }

    const waitFilter = async (needle: string, timeoutMs = 5000): Promise<string> => {
      let last = ''
      await waitUntil(async () => {
        last = await pageFilter()
        return last.includes(needle)
      }, timeoutMs)
      return last
    }

    const clipsOnDisk = async (): Promise<string[]> => {
      try {
        return (await readdir(host.clipDir())).filter((name) => name.endsWith('.md')).sort()
      } catch {
        // No directory yet is the honest "no clips": the clipper creates it on first write.
        return []
      }
    }

    // 32a. A new tile is light, and light means no stylesheet at all — not an inverted
    //      page whose button forgot to say so.
    const startChrome = await chromeState()
    const startFilter = await pageFilter()
    check(
      'dark mode: a new tile starts light',
      startChrome !== null && startChrome.pressed === 'false' && startChrome.active === false && startFilter === 'none',
      `chrome=${JSON.stringify(startChrome)} filter=${startFilter}`,
    )

    // 32b. The press reaches main, and the stylesheet really lands on the page.
    const pressedOn = await pressChrome('.tile-dark-toggle')
    const recordedOn = await waitFor(() => host.darkOf(subject) === true, 5000)
    const liveFilter = await waitFilter('invert')
    check(
      'dark mode: the button turns the page dark',
      pressedOn && recordedOn && liveFilter.includes('invert'),
      `recorded=${String(host.darkOf(subject))} filter=${liveFilter}`,
    )
    const litChrome = await chromeState()
    check(
      'dark mode: the button reports the state main reached, not the press',
      litChrome?.pressed === 'true' && litChrome.active === true,
      JSON.stringify(litChrome),
    )

    // 32c. A new document gets a new stylesheet. Navigating to a *different* page is the
    //      only way to tell a re-injection from the old document still being on screen:
    //      the check waits for the new page's own text before reading the filter.
    //
    //      The body text is assembled by the page's own script, so it does *not* appear
    //      anywhere in the data: URL. A marker typed straight into the HTML would also end
    //      up in `source:`, and the clipper check below would then pass with an empty
    //      body — which is exactly what happened the first time this section was written.
    const clipBody = 'BODY-TEXT-1789'
    const pageTwo = `data:text/html,${encodeURIComponent(
      `<!doctype html><html><head><title>Second Page</title></head><body><p></p><script>document.querySelector('p').textContent = ['BODY','TEXT','1789'].join('-')</script></body></html>`,
    )}`
    await host.registry.contentsOf(subject)?.loadURL(pageTwo)
    const navigated = await waitUntil(async () => (await pageText()).includes(clipBody), 8000)
    const afterNavFilter = await waitFilter('invert', 8000)
    check(
      'dark mode survives navigation to a new document',
      navigated && afterNavFilter.includes('invert') && host.darkOf(subject) === true,
      `navigated=${navigated} filter=${afterNavFilter}`,
    )

    // 32d. Saving writes the flag, and only for the dark tile.
    await task(`{ kind: 'save', name: ${JSON.stringify(darkName)} }`)
    const darkRaw = JSON.parse(await readFile(host.store.pathFor(darkName), 'utf8')) as {
      tiles: Array<Record<string, unknown>>
    }
    check(
      'dark mode: the saved workspace records darkMode: true',
      darkRaw.tiles[0]?.darkMode === true,
      JSON.stringify(darkRaw.tiles[0] ?? null),
    )

    // 32e. Reopening the workspace restores the flag *and* the paint. This is the hop that
    //      fails silently when a whitelist forgets the field: the file is right, the tile
    //      comes back light, and nothing says so.
    await task(`{ kind: 'new-workspace' }`)
    await waitFor(() => host.inventory().length === 0, 3000)
    const reopened = await task(`{ kind: 'switch', name: ${JSON.stringify(darkName)} }`)
    const restoredFlag = await waitFor(() => host.darkOf(subject) === true, 8000)
    const restoredFilter = await waitFilter('invert', 8000)
    const restoredChrome = await chromeState()
    check(
      'dark mode: reopening a workspace restores the flag and the paint',
      reopened.ok === true && restoredFlag && restoredFilter.includes('invert') && restoredChrome?.pressed === 'true',
      `${reopened.error ?? ''} flag=${String(host.darkOf(subject))} filter=${restoredFilter} chrome=${JSON.stringify(restoredChrome)}`,
    )

    // 32f. A container move rebuilds the view on a different session. The flag travels
    //      with the tile; the inserted stylesheet does not, so it has to be asked for
    //      again or the tile is dark in the file and light on screen.
    const darkMoved = await task(`{ kind: 'move-tile', id: ${JSON.stringify(subject)}, partition: 'persist:smoke-dark' }`)
    const darkMovedFlag = await waitFor(() => host.darkOf(subject) === true, 6000)
    const darkMovedFilter = await waitFilter('invert', 10000)
    check(
      'dark mode survives a container move',
      darkMoved.ok === true && darkMovedFlag && darkMovedFilter.includes('invert'),
      `${darkMoved.error ?? ''} flag=${String(host.darkOf(subject))} filter=${darkMovedFilter}`,
    )

    // 32g. Off is off, and a light tile writes no key — the absence rule real saves keep.
    await pressChrome('.tile-dark-toggle')
    const recordedOff = await waitFor(() => host.darkOf(subject) === false, 5000)
    const offFilter = await waitFilter('none')
    const offChrome = await chromeState()
    check(
      'dark mode: turning it off clears the page as well as the flag',
      recordedOff && offFilter === 'none' && offChrome?.pressed === 'false',
      `flag=${String(host.darkOf(subject))} filter=${offFilter} chrome=${JSON.stringify(offChrome)}`,
    )
    await task(`{ kind: 'save', name: ${JSON.stringify(darkName)} }`)
    const lightRaw = JSON.parse(await readFile(host.store.pathFor(darkName), 'utf8')) as {
      tiles: Array<Record<string, unknown>>
    }
    check(
      'dark mode: a light tile writes no darkMode key',
      !('darkMode' in (lightRaw.tiles[0] ?? {})),
      JSON.stringify(Object.keys(lightRaw.tiles[0] ?? {})),
    )

    // 32h. The clipper. The note must carry the page's own title, URL and text, and it
    //      must appear in the configured directory — the button pulsing is not evidence.
    const clipsBefore = await clipsOnDisk()
    check('clipper: nothing on disk before the press', clipsBefore.length === 0, clipsBefore.join(' | '))

    const pressedClip = await pressChrome('.tile-clip-obsidian')
    const clipped = await waitUntil(async () => (await clipsOnDisk()).length === 1, 8000)
    // Read the pulse while the note exists: it is 1.5 s and will be gone afterwards.
    const pulsed = await waitForEval(
      host.canvas,
      `!!document.querySelector('.tile[data-tile-id="${subject}"] .tile-clip-obsidian.clip-ok')`,
      3000,
    )
    check('clipper: a press writes exactly one note', pressedClip && clipped, `${(await clipsOnDisk()).length} file(s)`)
    check('clipper: the button pulses a checkmark', pulsed === true)

    const firstClipName = (await clipsOnDisk())[0] ?? ''
    const firstClip = firstClipName ? await readFile(join(host.clipDir(), firstClipName), 'utf8') : ''
    const heading = '\n# Second Page\n'
    const noteBody = firstClip.includes(heading) ? firstClip.slice(firstClip.indexOf(heading) + heading.length).trim() : ''
    const pageBody = (await pageText()).trim()
    check(
      'clipper: the note is frontmatter plus a heading plus the page text',
      firstClip.startsWith('---\ntitle: "Second Page"\n') &&
        firstClip.includes('\nsource: "data:text/html,') &&
        /\nclipped: "\d{4}-\d{2}-\d{2}T/.test(firstClip) &&
        // The body is compared to the page's own text, and the marker is proven absent
        // from the URL: otherwise a clip with no body at all would satisfy this.
        !pageTwo.includes(clipBody) &&
        noteBody === pageBody &&
        noteBody.includes(clipBody),
      `body=${JSON.stringify(noteBody.slice(0, 80))} page=${JSON.stringify(pageBody.slice(0, 80))}`,
    )

    // 32i. A second press in the same minute is a second note, not a silent overwrite.
    await pressChrome('.tile-clip-obsidian')
    const twice = await waitUntil(async () => (await clipsOnDisk()).length === 2, 8000)
    const bothNames = await clipsOnDisk()
    check(
      'clipper: a second clip lands beside the first',
      twice && bothNames.length === 2 && bothNames[0] !== bothNames[1],
      bothNames.join(' | '),
    )

    // 32j. Both features refuse honestly on a tile that is gone, rather than reporting a
    //      state they could not have reached.
    await task(`{ kind: 'tile-close', id: ${JSON.stringify(subject)} }`)
    const gone = await waitFor(() => host.darkOf(subject) === null, 4000)
    const deadDark = await evaluate<{ on?: boolean; error?: string }>(
      host.canvas,
      `window.canvasBridge.setTileDark(${JSON.stringify(subject)}, true)`,
    )
    const deadClip = await evaluate<{ ok?: boolean; error?: string }>(
      host.canvas,
      `window.canvasBridge.clipTile(${JSON.stringify(subject)})`,
    )
    check(
      'dark mode: a tile that is gone refuses instead of claiming a state',
      gone && deadDark.on === false && deadDark.error === 'no such tile',
      JSON.stringify(deadDark),
    )
    check(
      'clipper: clipping a tile that is gone refuses',
      deadClip.ok === false && typeof deadClip.error === 'string',
      JSON.stringify(deadClip),
    )

    // 33. Edit shortcuts and context menus.
    //
    //     macOS routes ⌘C/⌘V through the application menu, and this app's window is a BaseWindow:
    //     Electron's `role:` handlers reach for the focused BrowserWindow, so every Edit role is
    //     inert here. Measured: invoking `role: 'copy'`'s own click handler with a tile focused and
    //     text selected left the clipboard alone; an item that calls the focused webContents moved
    //     it. The checks below invoke the real menu items — the same handler Cocoa invokes on the
    //     key equivalent — and then right-click the page and read the template Chromium produced.
    const appMenu = Menu.getApplicationMenu()
    const editSubmenu = appMenu?.items.find((item) => item.label === 'Edit')?.submenu?.items ?? []
    const editItem = (label: string) => editSubmenu.find((item) => item.label === label) ?? null
    const editLabels = editSubmenu
      .map((item) => item.label || String(item.role ?? ''))
      .filter((label) => label.length > 0)
    const copyItem = editItem('Copy')
    const pasteItem = editItem('Paste')
    check(
      'the application menu carries Edit items with the stock accelerators',
      editLabels.includes('Copy') &&
        editLabels.includes('Paste') &&
        editLabels.includes('Cut') &&
        editLabels.includes('Select All') &&
        copyItem?.accelerator === 'CmdOrCtrl+C' &&
        pasteItem?.accelerator === 'CmdOrCtrl+V',
      `${JSON.stringify(editLabels)} copy=${String(copyItem?.accelerator)}`,
    )
    // The load-bearing half: a `role: 'copy'` item would exist here too and do nothing, so the fix
    // is that these are custom items whose handler targets the focused webContents. Electron
    // reports `role: null` on a custom item, not undefined.
    check(
      'the Edit items are custom, not the inert BaseWindow roles',
      copyItem !== null && pasteItem !== null && !copyItem.role && !pasteItem.role,
      `copyRole=${String(copyItem?.role)} pasteRole=${String(pasteItem?.role)}`,
    )

    /** Invoke a menu item the way the menu itself does: its own click handler. */
    const invokeItem = (item: typeof copyItem): void => {
      const target = item as unknown as { click?: (...args: unknown[]) => void } | null
      target?.click?.(target, undefined, {})
    }

    const editWs = await task(`{ kind: 'new-workspace' }`)
    await waitFor(() => host.inventory().length === 0, 3000)
    const editPage =
      'data:text/html,' +
      encodeURIComponent(
        '<!doctype html><title>Edit Probe</title><body style="margin:0;font:20px sans-serif">' +
          '<p id="p" style="margin:0;height:40px">SMOKE-EDIT-TEXT</p>' +
          '<input id="i" style="display:block;width:300px;height:30px;font:20px sans-serif">' +
          '<a id="a" href="https://example.com/smoke-link" style="display:block;height:30px">a link</a>' +
          '<div style="height:220px"></div></body>',
      )
    const editCreated = await task(`{ kind: 'create', input: ${JSON.stringify(editPage)} }`)
    const editId = host.inventory()[0]?.id ?? ''
    const editContents = editId ? host.registry.contentsOf(editId) : null
    check(
      'edit probe: a tile to copy from and right-click in',
      editCreated.ok === true && editWs.ok === true && editContents !== null,
      `${editCreated.error ?? ''} id=${editId}`,
    )

    const onPage = async <T>(script: string): Promise<T | null> => {
      if (!editContents || editContents.isDestroyed()) return null
      try {
        return (await editContents.executeJavaScript(script, true)) as T
      } catch {
        return null
      }
    }
    const waitForPage = async (script: string, timeoutMs = 8000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if ((await onPage<boolean>(script)) === true) return true
        await wait(100)
      }
      return false
    }
    const pageLoaded = await waitForPage(`!!document.getElementById('p')`)
    check('edit probe: the page loaded', pageLoaded === true)

    /**
     * Make the tile's view the focused one, and say whether that really held.
     *
     * Both edit checks below reach the page through `getFocusedWebContents()` and the paste is
     * dropped unless this app is actually frontmost — that flag is per-app, so it can read
     * "focused" while Terminal or Finder owns the screen, and the check then reported `input=""`,
     * which names no cause. The predicate is the window being key *and* the tile being its focused
     * view; the escalation steals app focus once, because a launch assertion that runs unattended
     * cannot assume it was ever given focus.
     */
    const editFocus = (): boolean =>
      !host.window.isDestroyed() &&
      host.window.isFocused() &&
      webContents.getFocusedWebContents() === editContents
    const focusEditTile = async (): Promise<boolean> => {
      if (!editContents || editContents.isDestroyed()) return false
      editContents.focus()
      if (await waitFor(editFocus, 800)) return true
      app.focus({ steal: true })
      host.window.focus()
      editContents.focus()
      return waitFor(editFocus, 2500)
    }

    // ⌘C: the page's own selection, then the menu item the accelerator would run.
    const selected =
      (await onPage<string>(`(() => {
        const p = document.getElementById('p')
        const range = document.createRange()
        range.selectNodeContents(p)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        return selection.toString()
      })()`)) ?? ''
    const tileFocused = await focusEditTile()
    await clipboard.writeText('SMOKE-SENTINEL')
    invokeItem(copyItem)
    await wait(400)
    const copied = await clipboard.readText()
    check(
      "the Edit Copy item puts the focused tile's selection on the clipboard",
      tileFocused && selected === 'SMOKE-EDIT-TEXT' && copied === 'SMOKE-EDIT-TEXT',
      `focused=${tileFocused} win=${!host.window.isDestroyed() && host.window.isFocused()} selected=${JSON.stringify(selected)} clipboard=${JSON.stringify(copied)}`,
    )

    // ⌘V: the clipboard into the page's own field, through the menu item again. Focus is
    // re-established and verified here rather than inherited from the copy above: a window
    // activation between the two steps is enough to send the paste nowhere, which is exactly
    // what the packaged launch assertion hit on a good build.
    await clipboard.writeText('SMOKE-PASTED')
    await onPage(`document.getElementById('i').focus()`)
    const pasteFocused = await focusEditTile()
    await wait(200)
    invokeItem(pasteItem)
    await wait(400)
    const pastedValue = (await onPage<string>(`document.getElementById('i').value`)) ?? ''
    check(
      'the Edit Paste item inserts the clipboard into the focused field',
      pasteFocused && pastedValue === 'SMOKE-PASTED',
      `focused=${pasteFocused} win=${!host.window.isDestroyed() && host.window.isFocused()} input=${JSON.stringify(pastedValue)}`,
    )

    const rightClick = async (x: number, y: number): Promise<void> => {
      if (!editContents || editContents.isDestroyed()) return
      editContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 })
      editContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 })
      await wait(400)
    }
    const menuIds = (): string[] =>
      host.contextMenu().flatMap((entry) => (entry.kind === 'command' ? [entry.id] : []))
    const menuEntry = (id: string): ContextMenuEntry | null =>
      host.contextMenu().find((entry) => entry.kind === 'command' && entry.id === id) ?? null

    // 33a. Empty space offers nothing, and main must not pop a box with no items in it.
    await onPage(`window.getSelection().removeAllRanges()`)
    await rightClick(40, 200)
    check('right-clicking empty space builds no menu', host.contextMenu().length === 0, JSON.stringify(menuIds()))

    // 33b. Inside the page's field: the edit block, with Chromium's own flags deciding `enabled`.
    await rightClick(40, 55)
    const fieldIds = menuIds()
    const pasteEntry = menuEntry('paste')
    check(
      'right-clicking an editable field offers the edit commands',
      fieldIds.includes('paste') &&
        fieldIds.includes('cut') &&
        fieldIds.includes('select-all') &&
        pasteEntry !== null &&
        pasteEntry.kind === 'command' &&
        pasteEntry.enabled === true,
      JSON.stringify(host.contextMenu()),
    )

    // 33c. Over a link: both link commands, named for what they do.
    await rightClick(40, 84)
    const linkIds = menuIds()
    check(
      'right-clicking a link offers open-in-new-tile and copy-address',
      linkIds.includes('open-link') && linkIds.includes('copy-link'),
      JSON.stringify(host.contextMenu()),
    )

    // 33d. A read-only selection: copy is the only edit, plus the search that follows it.
    await onPage(`(() => {
      const p = document.getElementById('p')
      const range = document.createRange()
      range.selectNodeContents(p)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.getElementById('i').blur()
    })()`)
    await wait(150)
    await rightClick(40, 20)
    const selectionIds = menuIds()
    check(
      'right-clicking a selection offers copy and a search',
      selectionIds.includes('copy') && selectionIds.includes('search-selection'),
      JSON.stringify(host.contextMenu()),
    )

    // 34. Bookmarks: one flat file, a star that reports what main reached, recall from
    //     the omnibox and the shelf, and a link entry in the right-click menu.
    //
    //     Every hop below is the real one: the star is pressed through Electron's input
    //     pipeline, the suggestion is a chip the dock built from a config push, the shelf
    //     row is a row main pushed, and the menu entry is the real Menu's own click
    //     handler. The file is read back from disk at the end — an in-memory list that
    //     agrees with itself proves nothing about what was saved.
    const bmWs = await task(`{ kind: 'new-workspace' }`)
    await waitFor(() => host.inventory().length === 0, 4000)
    check(
      'bookmarks: a fresh workspace and an empty file',
      bmWs.ok === true && host.bookmarks().length === 0 && host.bookmarkPath().endsWith('bookmarks.json'),
      `${bmWs.error ?? ''} kept=${host.bookmarks().length} path=${host.bookmarkPath()}`,
    )

    const bmPage =
      'data:text/html,' +
      encodeURIComponent(
        '<!doctype html><title>Bookmark Probe</title><body style="margin:8px;font:14px sans-serif">' +
          '<a id="l" href="https://example.com/bm-link" style="display:block;height:30px">bm link</a>' +
          '</body>',
      )
    // `@work` gives the tile its own container, which is what makes the container-affinity
    // half of the bookmark a real assertion rather than a field that happens to be absent.
    const bmCreated = await task(`{ kind: 'create', input: ${JSON.stringify(`@work ${bmPage}`)} }`)
    const bmReady = await waitFor(() => host.inventory().length === 1, 5000)
    const bmId = host.inventory()[0]?.id ?? ''
    check(
      'bookmarks: a tile in its own container to bookmark',
      bmCreated.ok === true && bmReady && bmId !== '' && host.registry.partitionOf(bmId) === 'persist:work',
      `${bmCreated.error ?? ''} id=${bmId} partition=${bmId ? host.registry.partitionOf(bmId) : 'none'}`,
    )

    // Isolate and centre: a title bar under another tile's view cannot be pressed, and a
    // press that misses would make every star check below prove the wrong thing.
    await evaluate<number>(
      host.canvas,
      `(() => {
        let closed = 0
        for (const node of [...document.querySelectorAll('.tile')]) {
          if (node.dataset.tileId === ${JSON.stringify(bmId)}) continue
          const button = node.querySelector('.light.close')
          if (button instanceof HTMLElement) { button.click(); closed += 1 }
        }
        return closed
      })()`,
    )
    await waitFor(() => host.registry.size === 1, 4000)
    await evaluate<boolean>(
      host.sidebar,
      `(() => {
        document.querySelector('[data-role="bookmarks"]').click()
        const row = document.querySelector('[data-tile-id=${JSON.stringify(bmId)}]')
        if (!(row instanceof HTMLElement)) return false
        row.click()
        return true
      })()`,
    )
    await wait(500)

    /** Press a control in a tile's title bar the way a person would. */
    const pressTileControl = async (id: string, role: string): Promise<boolean> => {
      const rect = await evaluate<Rect | null>(
        host.canvas,
        `(() => {
          const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(id)})
          const button = el ? el.querySelector('[data-role="${role}"]') : null
          if (!button) return null
          const r = button.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        })()`,
      )
      if (!rect) return false
      const x = Math.round(rect.x + rect.width / 2)
      const y = Math.round(rect.y + rect.height / 2)
      if (x < 0 || y < 0 || x >= windowRect.width || y >= windowRect.height) return false
      host.canvas.webContents.focus()
      host.canvas.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      host.canvas.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      await wait(90)
      host.canvas.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      await wait(350)
      return true
    }

    const starState = (): Promise<{ pressed: string | null; glyph: string } | null> =>
      evaluate<{ pressed: string | null; glyph: string } | null>(
        host.canvas,
        `(() => {
          const el = [...document.querySelectorAll('.tile')].find((node) => node.dataset.tileId === ${JSON.stringify(bmId)})
          const button = el ? el.querySelector('[data-role="bookmark"]') : null
          return button ? { pressed: button.getAttribute('aria-pressed'), glyph: (button.textContent ?? '') } : null
        })()`,
      )

    const starPressed = await pressTileControl(bmId, 'bookmark')
    const starOn = await starState()
    const savedBookmark = host.bookmarks()[0] ?? null
    check(
      'the star saves the page, with its container, and the button reports it',
      starPressed &&
        host.bookmarks().length === 1 &&
        savedBookmark !== null &&
        savedBookmark.title === 'Bookmark Probe' &&
        savedBookmark.url === bmPage &&
        savedBookmark.container === 'persist:work' &&
        starOn?.pressed === 'true' &&
        starOn.glyph === '★',
      `${JSON.stringify(savedBookmark)} star=${JSON.stringify(starOn)}`,
    )

    /** Read the file as a second process would. A missing file is a null, not a throw. */
    const readBookmarkFile = async (): Promise<{ version?: number; bookmarks?: { url?: string; container?: string }[] } | null> => {
      try {
        return JSON.parse(await readFile(host.bookmarkPath(), 'utf8')) as {
          version?: number
          bookmarks?: { url?: string; container?: string }[]
        }
      } catch {
        return null
      }
    }
    const bmFile = await readBookmarkFile()
    check(
      'the bookmark file is one flat document, written atomically',
      bmFile !== null &&
        bmFile.version === 1 &&
        Array.isArray(bmFile.bookmarks) &&
        bmFile.bookmarks.length === 1 &&
        bmFile.bookmarks[0]?.container === 'persist:work',
      JSON.stringify(bmFile).slice(0, 220),
    )

    // The other half of a toggle. Nothing else has changed, so the second press is the
    // only reason the record could be gone.
    await pressTileControl(bmId, 'bookmark')
    const starOff = await starState()
    check(
      'a second press forgets the page and hollows the star',
      host.bookmarks().length === 0 && starOff?.pressed === 'false' && starOff.glyph === '☆',
      `kept=${host.bookmarks().length} star=${JSON.stringify(starOff)}`,
    )

    // Save it again: the recall checks below need one row.
    await pressTileControl(bmId, 'bookmark')
    await waitFor(() => host.bookmarks().length === 1, 3000)

    // 34a. The omnibox suggestion. Typing never reaches main, so this is the dock's own
    //      match over the list the last config push carried.
    await evaluate<void>(
      host.dock,
      `(() => {
        const input = document.querySelector('[data-role="omnibox"]')
        input.focus()
        input.value = 'bookmark'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return undefined
      })()`,
    )
    const suggestionShown = await waitForEval(host.dock, `!!document.querySelector('[data-bookmark]')`, 2500)
    const suggestionText = await evaluate<string>(
      host.dock,
      `(() => { const chip = document.querySelector('[data-bookmark]'); return chip ? (chip.textContent ?? '') : '' })()`,
    )
    check(
      'the omnibox offers the saved page as it is typed',
      suggestionShown && suggestionText.includes('Bookmark Probe'),
      JSON.stringify(suggestionText),
    )

    const beforeSuggestion = host.registry.size
    await evaluate<void>(
      host.dock,
      `(() => { const chip = document.querySelector('[data-bookmark]'); if (chip instanceof HTMLElement) chip.click(); return undefined })()`,
    )
    const suggestionOpened = await waitFor(() => host.registry.size === beforeSuggestion + 1, 6000)
    const suggestionId = host.registry.ids.find((id) => id !== bmId) ?? ''
    check(
      'a suggestion opens the page in the container it was saved from',
      suggestionOpened && suggestionId !== '' && host.registry.partitionOf(suggestionId) === 'persist:work',
      `tiles=${host.registry.size} new=${suggestionId} partition=${suggestionId ? host.registry.partitionOf(suggestionId) : 'none'}`,
    )

    // 34b. The sidebar shelf: the same list, one row per bookmark, in flow.
    const beforeShelf = host.registry.size
    const shelfRows = await waitForEval(
      host.sidebar,
      `document.querySelectorAll('.bk-menu [data-bookmark-id]').length === 1`,
      3000,
    )
    const shelfText = await evaluate<string>(
      host.sidebar,
      `(() => { const row = document.querySelector('.bk-menu [data-bookmark-id]'); return row ? (row.textContent ?? '') : '' })()`,
    )
    check(
      'the sidebar shelf lists the bookmark',
      shelfRows && shelfText.includes('Bookmark Probe'),
      JSON.stringify(shelfText),
    )
    await evaluate<void>(
      host.sidebar,
      `(() => { const row = document.querySelector('.bk-menu [data-bookmark-id]'); if (row instanceof HTMLElement) row.click(); return undefined })()`,
    )
    const shelfOpened = await waitFor(() => host.registry.size === beforeShelf + 1, 6000)
    const shelfClosed = await waitForEval(
      host.sidebar,
      `document.querySelector('.bk-menu')?.hasAttribute('hidden') === true`,
      2500,
    )
    check(
      'a shelf row launches the page and the shelf gets out of the way',
      shelfOpened && shelfClosed,
      `tiles=${host.registry.size} closed=${shelfClosed}`,
    )

    // 34c. The link menu. A right-click on the probe's link must offer the entry, and the
    //      entry must actually file the address — the label alone is a promise.
    const bmContents = host.registry.contentsOf(bmId)
    const bmRightClick = async (x: number, y: number): Promise<void> => {
      if (!bmContents || bmContents.isDestroyed()) return
      bmContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 })
      bmContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 })
      await wait(400)
    }
    const menuItem = (label: string) => host.contextMenuMenu()?.items.find((item) => item.label === label) ?? null
    const invokeMenuItem = (item: ReturnType<typeof menuItem>): void => {
      const target = item as unknown as { click?: (...args: unknown[]) => void } | null
      target?.click?.(target, undefined, {})
    }
    const linkRecord = () => host.bookmarks().find((record) => record.url === 'https://example.com/bm-link') ?? null

    check('bookmarks: the probe link is not saved yet', linkRecord() === null, JSON.stringify(host.bookmarks().map((record) => record.url)))
    await bmRightClick(40, 22)
    const offer = host.contextMenu().find((entry) => entry.kind === 'command' && entry.id === 'bookmark-link')
    check(
      'right-clicking a link offers Bookmark Link',
      offer !== undefined && offer.kind === 'command' && offer.label === 'Bookmark Link',
      JSON.stringify(host.contextMenu()),
    )
    invokeMenuItem(menuItem('Bookmark Link'))
    const linkSaved = await waitFor(() => linkRecord() !== null, 4000)
    check(
      "the link entry files the address in the tile's container",
      linkSaved && linkRecord()?.container === 'persist:work',
      JSON.stringify(host.bookmarks().map((record) => [record.url, record.container ?? ''])),
    )

    // Same entry, other state: the label says which half it is, and the press undoes it.
    await bmRightClick(40, 22)
    const offerAgain = host.contextMenu().find((entry) => entry.kind === 'command' && entry.id === 'bookmark-link')
    check(
      'the same entry reads Remove Bookmark once the link is saved',
      offerAgain !== undefined && offerAgain.kind === 'command' && offerAgain.label === 'Remove Bookmark',
      JSON.stringify(host.contextMenu()),
    )
    invokeMenuItem(menuItem('Remove Bookmark'))
    check(
      'pressing it again forgets the link',
      await waitFor(() => linkRecord() === null, 4000),
      JSON.stringify(host.bookmarks().map((record) => record.url)),
    )

    // 34d. The file is the record. A second reader, with no memory of this process, has to
    //      see exactly what main holds — this is the hop a broadcast cannot prove.
    const reread = new BookmarkFile(dirname(host.bookmarkPath()))
    await reread.load()
    const fromDisk = reread.list()
    check(
      'a fresh read of bookmarks.json returns what main holds',
      fromDisk.length === host.bookmarks().length &&
        fromDisk.length === 1 &&
        fromDisk[0]?.url === host.bookmarks()[0]?.url &&
        fromDisk[0]?.container === 'persist:work',
      `${JSON.stringify(fromDisk.map((record) => record.url))} vs ${JSON.stringify(host.bookmarks().map((record) => record.url))}`,
    )

    // 35. Autosave and the session latch. The pain this fixes: rearrange a canvas, quit,
    //      come back to the tiles and the camera you left — without pressing ⌘S.
    //
    //      A run cannot relaunch itself, so the mechanism is asserted in four parts: a
    //      change with no save command reaches the file, a *cold* reader gets exactly the
    //      tiles and camera the canvas has, session.json names that workspace (which is
    //      the one thing the boot path reads), and the quit-time flush writes state the
    //      debounce has not reached. What is left for a human is the relaunch itself, the
    //      same way the menu's ⌘C half is.
    const autoWs = await task(`{ kind: 'new-workspace' }`)
    const autoName = autoWs.name ?? ''
    check('autosave: a fresh workspace to change', autoWs.ok === true && autoName !== '', autoWs.error ?? '')
    await waitFor(() => host.inventory().length === 0, 3000)

    const autoUrl = (tag: string): string =>
      `data:text/html,${encodeURIComponent(
        `<!doctype html><title>Auto ${tag}</title><body style="margin:0">${tag}</body>`,
      )}`
    const autoTiles = ['one', 'two'].map(autoUrl)
    for (const url of autoTiles) {
      await task(`{ kind: 'create', input: ${JSON.stringify(url)} }`)
    }
    check(
      'autosave: two tiles to remember',
      await waitFor(() => host.inventory().length === 2, 4000),
      `tiles=${host.inventory().length}`,
    )

    // A camera move, so the viewport in the file cannot be the default by accident. The
    // zoom is read from the canvas's own painted `--zoom`, not from `host.status()`: the
    // status push lands a frame later, and a check that reads it right after the RPC is
    // comparing the file against the *previous* camera and blames the file.
    await task(`{ kind: 'fit-view' }`)
    const liveZoom = await (async (): Promise<number> => {
      const painted = `Number(getComputedStyle(document.documentElement).getPropertyValue('--zoom'))`
      await waitForEval(host.canvas, `${painted} > 1.01`, 3000)
      return evaluate<number>(host.canvas, painted)
    })()
    check('autosave: the camera moved before anything was saved', liveZoom > 1.01, `zoom=${liveZoom}`)

    // No save command anywhere above this line: the file appears because main debounced
    // the canvas's own change signal.
    const autosaved = await waitFor(() => host.lastAutosave()?.name === autoName, 5000)
    check('autosave: a change reaches the file with no save command', autosaved, JSON.stringify(host.lastAutosave()))

    const onDisk = await host.store.load(autoName)
    check('autosave: the workspace file holds both tiles', onDisk?.tiles.length === 2, `tiles=${onDisk?.tiles.length ?? -1}`)
    check(
      'autosave: the tile URLs are the ones the canvas opened',
      onDisk?.tiles.map((tile) => tile.url).sort().join('|') === [...autoTiles].sort().join('|'),
      JSON.stringify((onDisk?.tiles ?? []).map((tile) => tile.url)),
    )
    check(
      'autosave: the camera was persisted, not reset',
      onDisk !== null && Math.abs(onDisk.viewport.zoom - liveZoom) < 0.01,
      `file=${onDisk?.viewport.zoom ?? -1} canvas=${liveZoom}`,
    )

    // The boot path in one line: a second store, with no memory of this process, reading
    // the session file and then the workspace it names — exactly what `boot()` does.
    const cold = new WorkspaceStore(host.store.root)
    const coldSession = await cold.session()
    check(
      'the session file names the workspace that was just autosaved',
      coldSession.lastWorkspace === autoName,
      `${String(coldSession.lastWorkspace)} vs ${autoName}`,
    )
    const coldRestored: WorkspaceState | null = coldSession.lastWorkspace
      ? await cold.load(coldSession.lastWorkspace)
      : null
    check(
      'a cold reader restores the same tiles the canvas is showing',
      coldRestored !== null &&
        coldRestored.tiles.length === host.inventory().length &&
        coldRestored.tiles.map((tile) => tile.url).sort().join('|') ===
          host.inventory().map((tile) => tile.url).sort().join('|'),
      `${coldRestored?.tiles.length ?? -1} vs ${host.inventory().length}`,
    )
    check(
      'and the same camera transform',
      coldRestored !== null && Math.abs(coldRestored.viewport.zoom - liveZoom) < 0.01,
      `restored=${coldRestored?.viewport.zoom ?? -1} canvas=${liveZoom}`,
    )

    // The quit half: a change made now, written by the same call the close and quit
    // handlers make, with the flush's own record proving it was the last writer.
    const beforeFlush = host.lastAutosave()?.tiles ?? -1
    const flushStartedAt = Date.now()
    await task(`{ kind: 'create', input: ${JSON.stringify(autoUrl('three'))} }`)
    await host.flushActive()
    const flushedRecord = host.lastAutosave()
    const flushed = await host.store.load(autoName)
    check(
      'the quit-time flush writes the newest tile, not the last debounced state',
      beforeFlush === 2 && flushedRecord?.tiles === 3 && (flushedRecord?.at ?? 0) >= flushStartedAt,
      `before=${beforeFlush} after=${flushedRecord?.tiles ?? -1}`,
    )
    check(
      'and that third tile is on disk',
      flushed?.tiles.length === 3 && flushed.tiles.some((tile) => tile.url === autoUrl('three')),
      `tiles=${flushed?.tiles.length ?? -1}`,
    )

    // A page that navigates itself rewrites the URL the file stores, and no geometry
    // moves — the one change that never reaches the frame pipeline, so it is asserted
    // separately rather than assumed. The target is `about:blank` because Chromium
    // refuses a *page-initiated* navigation to a `data:` URL; the address only has to be
    // a value the file did not hold before.
    const navigatedUrl = 'about:blank'
    const navId = host.registry.ids[0] ?? ''
    try {
      const navContents = host.registry.contentsOf(navId)
      await navContents?.executeJavaScript(`location.href = ${JSON.stringify(navigatedUrl)}`)
    } catch {
      // The navigation replaces the document, which kills the call that started it.
    }
    let navUrl = ''
    const navDeadline = Date.now() + 5000
    while (Date.now() < navDeadline) {
      const state = await host.store.load(autoName)
      navUrl = state?.tiles.find((tile) => tile.id === navId)?.url ?? ''
      if (navUrl === navigatedUrl) break
      await wait(100)
    }
    check('a navigation is persisted with no save command', navUrl === navigatedUrl, navUrl)

    // Window geometry: the same write the close path makes, read back through the session
    // file and compared to the window that is actually on screen.
    await host.rememberWindow()
    const geometry = await host.store.session()
    const screenBounds = host.window.getBounds()
    check(
      'the window geometry is remembered beside the workspace',
      geometry.windowBounds !== undefined &&
        Math.abs(geometry.windowBounds.width - screenBounds.width) <= 1 &&
        Math.abs(geometry.windowBounds.height - screenBounds.height) <= 1,
      `${JSON.stringify(geometry.windowBounds ?? null)} vs ${screenBounds.width}x${screenBounds.height}`,
    )
    check(
      'and remembering it does not forget which workspace was open',
      geometry.lastWorkspace === autoName,
      String(geometry.lastWorkspace),
    )

    // 35e. A queued autosave must not land in the workspace the canvas was switched to.
    //      That is the class autosave first shipped with: the canvas signalled a change,
    //      the user switched, and the debounced write emptied the workspace it had already
    //      left (`[autosave] "smoke-test" (0 tile(s))` over a two-tile file). The name now
    //      comes back with the snapshot and an apply bumps the epoch, so this forces the
    //      race — dirty the canvas and switch in the same breath — and reads both files
    //      through a cold store rather than through main's own copy.
    const raceCold = new WorkspaceStore(host.store.root)
    const raceWs = await task(`{ kind: 'new-workspace' }`)
    const raceName = raceWs.name ?? ''
    const raceUrls = ['race-a', 'race-b'].map(autoUrl)
    for (const url of raceUrls) {
      await task(`{ kind: 'create', input: ${JSON.stringify(url)} }`)
    }
    const raceOnDisk = await (async (): Promise<boolean> => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const file = await raceCold.load(raceName)
        if (file?.tiles.length === 2) return true
        await wait(100)
      }
      return false
    })()
    // The baseline is the point: without it a check on the *target* file would compare
    // against a workspace that never had tiles, and "still two tiles" would mean nothing.
    check('autosave race: the workspace to be left holds its two tiles on disk', raceOnDisk, raceName)

    await task(`{ kind: 'switch', name: ${JSON.stringify(autoName)} }`)
    await waitFor(() => host.inventory().length === 3, 5000)
    // A change with no save command, then the switch: the debounce is still armed when the
    // canvas is applied elsewhere, which is exactly the window the defect lived in.
    await task(`{ kind: 'create', input: ${JSON.stringify(autoUrl('four'))} }`)
    await task(`{ kind: 'switch', name: ${JSON.stringify(raceName)} }`)
    await wait(1500)
    const leftFile = await raceCold.load(autoName)
    const targetFile = await raceCold.load(raceName)
    check(
      'autosave race: a queued write cannot land in the workspace that was switched to',
      targetFile?.tiles.length === 2 &&
        targetFile.tiles.map((tile) => tile.url).sort().join('|') === [...raceUrls].sort().join('|'),
      `tiles=${targetFile?.tiles.length ?? -1}`,
    )
    check(
      'autosave race: the workspace that was left keeps its own tiles, never an empty canvas',
      (leftFile?.tiles.length ?? -1) >= 3,
      `tiles=${leftFile?.tiles.length ?? -1}`,
    )

    // The name a write lands under is the contract the stale-name defect broke, and it is
    // observable in one place: `lastAutosave()`. A camera move is the cheapest change that
    // emits a dirty signal without touching the tile count, so this reads the write that
    // follows the switch rather than the one the switch superseded.
    await task(`{ kind: 'fit-view' }`)
    const namedRight = await waitFor(() => host.lastAutosave()?.name === raceName, 5000)
    const lastWrite = host.lastAutosave()
    check(
      'autosave: the write that lands after a switch names the workspace on screen',
      namedRight && lastWrite?.name === host.status().workspace && lastWrite?.tiles === host.inventory().length,
      `wrote "${String(lastWrite?.name)}" ${String(lastWrite?.tiles)} tile(s); on screen "${host.status().workspace}" ${host.inventory().length} tile(s)`,
    )

  } catch (error) {
    check('smoke run completed without throwing', false, String(error))
  }

  console.log('\n[smoke] Waypoint MVP\n' + lines.map((line) => `  ${line}`).join('\n') + '\n')
  console.log(failures.length === 0 ? '[smoke] all checks passed' : `[smoke] ${failures.length} failure(s): ${failures.join(', ')}`)
  return failures.length === 0 ? 0 : 1
}
