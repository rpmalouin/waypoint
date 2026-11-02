import {
  CHROME_WORLD_HEIGHT,
  MIN_TILE_WORLD_H,
  MIN_TILE_WORLD_W,
} from '../shared/constants.ts'
import type { TileLayout } from '../shared/math.ts'
import { displayTitle, faviconLetter, hueFor, resizeFree } from '../shared/math.ts'
import type { Corner } from '../shared/math.ts'
import { capturePointer, releasePointer } from './pointer.ts'
import {
  DEFAULT_TILE_PARTITION,
  containerLabel,
  isPersistentPartition,
  normalizeTilePartition,
} from '../shared/session-partition.ts'
import type { Rect, TileCommand, TileRecord, TileRuntime } from '../shared/types.ts'

export interface TileHooks {
  requestFrame: () => void
  zoom: () => number
  /**
   * A press on this tile: raise it, focus its view, and apply the selection rules
   * for `shift`. A press on a tile that is already selected keeps the whole
   * selection, which is what makes dragging a group possible.
   */
  focus: (id: string, modifiers?: { shift?: boolean }) => void
  /**
   * A press that ended without moving. This is where a click's selection effect
   * is settled — shift toggles the tile, and a plain click collapses a
   * multi-selection to it — because doing either on press would fight the drag.
   */
  click: (id: string, modifiers?: { shift?: boolean }) => void
  /** Freeze the origins of every tile this move drag will carry. */
  beginMove: (id: string) => void
  /** Move the frozen set by a world delta measured from the press. */
  moveBy: (id: string, dx: number, dy: number) => void
  endMove: () => void
  close: (id: string) => void
  command: (id: string, command: TileCommand) => void
  /** Move the camera so this tile is centred and whole — the green light. */
  fit: (id: string) => void
  /** The dark-mode button was pressed: the canvas asks main and stores the answer. */
  toggleDark: (id: string) => void
  /** The clip button was pressed: main extracts and files the page, then answers. */
  clip: (id: string) => void
  /** The star was pressed: main keeps or forgets the page and answers the state. */
  toggleBookmark: (id: string) => void
  /** A resize or collapse changed the model; the toolbar may want to react. */
  changed: (id: string) => void
}

type DragMode = 'move' | 'resize'

/**
 * Screen pixels a pointer may wander before a press counts as a drag. Below it the
 * release is a click, which is what lets a press both raise a tile and leave the
 * selection alone until the gesture is over.
 */
const DRAG_SLOP_PX = 2

interface DragState {
  pointerId: number
  startX: number
  startY: number
  origin: Rect
  mode: DragMode
  corner?: Corner
  /** Shift was held at the press, so a release without movement toggles. */
  shift: boolean
  /** Past the slop: this gesture drags, so it is not a click. */
  moved: boolean
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (!found) throw new Error(`tile markup is missing ${selector}`)
  return found
}

const CORNERS: Corner[] = ['nw', 'ne', 'se', 'sw']

/**
 * One tile's canvas-side presence: a DOM rectangle that mirrors the world
 * coordinates plus the chrome bar. The page itself lives in a WebContentsView
 * owned by the main process; this element only supplies the frame and the
 * non-interactive area behind it.
 *
 * Because the page view is stacked above this DOM, nothing that must be
 * clickable can sit under it: the title bar is above the view and the resize
 * grips straddle the tile's outer edge, so they stay outside the view's rect.
 */
export class Tile {
  readonly id: string
  readonly el: HTMLDivElement
  world: Rect
  url: string
  title: string
  /**
   * Session container, when this tile asked for its own. Undefined means the
   * shared default jar; either way it is written back out on save so a reload
   * reopens the tile in the same container. Mutable, because a tile can be moved
   * between containers while it is open — see `setPartition()`.
   */
  partition?: string
  /**
   * Whether this tile's page wears the inverted stylesheet. Mirrors what main reported
   * after the last toggle, never what was requested — see `setDarkMode()`.
   */
  darkMode = false

  /**
   * Whether this tile's page is in the bookmarks file. Mirrors what main reported after
   * the last toggle or broadcast, and is recomputed against the URL whenever the page
   * navigates — a star that stays lit across a navigation would be naming a page the
   * user is no longer looking at.
   */
  bookmarked = false

  private readonly chrome: HTMLDivElement
  private readonly errorEl: HTMLSpanElement
  private readonly labelEl: HTMLSpanElement
  private readonly titleEl: HTMLSpanElement
  private readonly faviconEl: HTMLSpanElement
  private readonly badgeEl: HTMLSpanElement
  private readonly darkButton: HTMLButtonElement
  private readonly bookmarkButton: HTMLButtonElement
  private readonly clipButton: HTMLButtonElement
  private readonly backButton: HTMLButtonElement
  private readonly forwardButton: HTMLButtonElement
  private drag: DragState | null = null
  private selected = false
  /** The pending "clip landed" pulse, so a second press cannot stack timers. */
  private clipTimer = 0
  /** Height to restore when the yellow light un-collapses the tile. */
  private restoreHeight: number | null = null

  constructor(
    record: TileRecord,
    private readonly hooks: TileHooks,
  ) {
    this.id = record.id
    this.world = { ...record.world }
    this.url = record.url
    this.title = record.title
    // Whatever the record says, the badge and the re-saved value only ever name a
    // partition main would accept: a hand-edited record must not display — or
    // write back — a string the registry silently replaced with the shared jar.
    const container = normalizeTilePartition(record.partition)
    this.partition = container === DEFAULT_TILE_PARTITION ? undefined : container

    this.el = document.createElement('div')
    this.el.className = 'tile'
    this.el.dataset.tileId = record.id
    this.el.innerHTML = `
      <div class="tile-chrome" data-role="chrome">
        <span class="lights" data-role="lights">
          <button class="light close" data-role="close" title="Close tile" aria-label="Close tile"></button>
          <button class="light collapse" data-role="collapse" title="Collapse to title bar" aria-label="Collapse tile"></button>
          <button class="light zoom" data-role="fit" title="Fit tile in view" aria-label="Fit tile in view"></button>
        </span>
        <span class="graph" data-role="grip" title="Drag tile">
          <span class="favicon" data-role="favicon"></span>
          <span class="tile-badge" data-role="container" hidden></span>
          <span class="tile-label" data-role="label"></span>
        </span>
        <span class="tools">
          <button class="ctl" data-role="back" title="Back">&#8249;</button>
          <button class="ctl" data-role="forward" title="Forward">&#8250;</button>
          <button class="ctl" data-role="reload" title="Reload">&#8635;</button>
          <button class="ctl tile-dark-toggle" data-role="dark" title="Dark mode: invert this page" aria-pressed="false">&#9680;</button>
          <button class="ctl tile-bookmark" data-role="bookmark" title="Bookmark this page" aria-pressed="false">&#9734;</button>
          <button class="ctl tile-clip-obsidian" data-role="clip" title="Clip this page to markdown">&#10087;</button>
        </span>
      </div>
      <div class="tile-body" data-role="body">
        <span class="tile-error" data-role="error"></span>
      </div>
      <span class="resize-grip resize-nw" data-corner="nw" data-role="corner"></span>
      <span class="resize-grip resize-ne" data-corner="ne" data-role="corner"></span>
      <span class="resize-grip resize-sw" data-corner="sw" data-role="corner"></span>
      <span class="resize-grip resize-se" data-corner="se" data-role="corner"></span>
    `

    this.chrome = must(this.el, '[data-role="chrome"]')
    this.errorEl = must(this.el, '[data-role="error"]')
    this.labelEl = must(this.el, '[data-role="label"]')
    this.titleEl = must(this.el, '[data-role="grip"]')
    this.faviconEl = must(this.el, '[data-role="favicon"]')
    this.backButton = must(this.el, '[data-role="back"]')
    this.forwardButton = must(this.el, '[data-role="forward"]')
    this.badgeEl = must(this.el, '[data-role="container"]')
    this.darkButton = must(this.el, '[data-role="dark"]')
    this.bookmarkButton = must(this.el, '[data-role="bookmark"]')
    this.clipButton = must(this.el, '[data-role="clip"]')

    // What the record says is off unless it says `true`: only a literal boolean survives
    // the loader, so anything else is the same as absent.
    this.darkMode = record.darkMode === true
    this.renderTitle()
    this.renderContainer()
    this.renderDark()
    this.renderBookmark()

    this.wireEvents()
  }

  applyLayout(layout: TileLayout, zoom: number): void {
    this.el.style.transform = `translate3d(${layout.tile.x}px, ${layout.tile.y}px, 0)`
    this.el.style.width = `${layout.tile.width}px`
    this.el.style.height = `${layout.tile.height}px`
    this.el.style.setProperty('--zoom', String(zoom))
    this.chrome.style.height = `${layout.chrome.height}px`
    this.el.classList.toggle('compact', !layout.chromeVisible || layout.tile.width < 380)
  }

  setRuntime(runtime: TileRuntime): void {
    if (runtime.url) this.url = runtime.url
    if (runtime.title) this.title = runtime.title
    this.renderTitle()
    this.errorEl.textContent = runtime.error ?? ''
    this.backButton.disabled = !runtime.canGoBack
    this.forwardButton.disabled = !runtime.canGoForward
    this.el.classList.toggle('loading', runtime.loading)
    this.el.classList.toggle('failed', Boolean(runtime.error))
  }

  setUrl(url: string): void {
    this.url = url
    this.renderTitle()
  }

  setSelected(selected: boolean): void {
    if (this.selected === selected) return
    this.selected = selected
    this.el.classList.toggle('tile-selected', selected)
  }

  /**
   * Re-point this tile at another jar, and report whether anything changed.
   *
   * The view is not this class's to rebuild: a partition is a `webPreferences`
   * value that Chromium reads when the WebContentsView is constructed, so the
   * canvas destroys and re-creates it (see `repartitionTile()` in `main.ts`). What
   * lives here is the record — the badge, and the string `collectSnapshot()`
   * writes back to the workspace — so those two can never disagree about the jar.
   */
  setPartition(partition: string): boolean {
    const normalized = normalizeTilePartition(partition)
    const next = normalized === DEFAULT_TILE_PARTITION ? undefined : normalized
    if (next === this.partition) return false
    this.partition = next
    this.renderContainer()
    return true
  }

  /** Yellow light: collapse to the title bar and back again. */
  toggleCollapse(): void {
    // The collapsed frame is exactly the title bar. Anything taller leaves a
    // sliver of the page showing under the bar: chrome is canvas DOM, so the
    // page view would paint over the part of the frame that is not the bar.
    if (this.restoreHeight === null) {
      this.restoreHeight = this.world.height
      this.world = { ...this.world, height: CHROME_WORLD_HEIGHT }
    } else {
      this.world = { ...this.world, height: Math.max(MIN_TILE_WORLD_H, this.restoreHeight) }
      this.restoreHeight = null
    }
    this.el.classList.toggle('collapsed', this.restoreHeight !== null)
    this.hooks.changed(this.id)
    this.hooks.requestFrame()
  }

  /** Green light: put the camera on this tile, centred and whole. */
  fitInView(): void {
    this.hooks.fit(this.id)
  }

  /**
   * Apply the dark-mode state main reported.
   *
   * The only writer of `darkMode`: the toggle asks, main inserts or removes the sheet and
   * answers, and this stores the answer. Flipping the flag on the press instead would let
   * the button claim a page is dark when the insert was refused (a crashed renderer, a
   * document that went away mid-click).
   */
  setDarkMode(on: boolean): void {
    this.darkMode = on
    this.renderDark()
  }

  /**
   * A 1.5 s glyph swap on the clip button, not a toast: main files the note, so the only
   * thing the chrome can honestly say is "that landed" — or "it did not". A second press
   * replaces the pending pulse rather than stacking timers.
   */
  pulseClip(ok: boolean): void {
    this.clipButton.classList.remove('clip-ok', 'clip-fail')
    this.clipButton.classList.add(ok ? 'clip-ok' : 'clip-fail')
    if (this.clipTimer !== 0) window.clearTimeout(this.clipTimer)
    this.clipTimer = window.setTimeout(() => {
      this.clipTimer = 0
      // A tile closed mid-pulse leaves a detached node; touching it is harmless, but
      // naming the state is what keeps the next press honest.
      this.clipButton.classList.remove('clip-ok', 'clip-fail')
    }, 1500)
  }

  private renderDark(): void {
    this.darkButton.classList.toggle('active', this.darkMode)
    this.darkButton.setAttribute('aria-pressed', this.darkMode ? 'true' : 'false')
    this.darkButton.title = this.darkMode ? 'Dark mode on — restore this page' : 'Dark mode: invert this page'
  }

  /**
   * Apply the bookmark state main reported.
   *
   * The only writer of `bookmarked`: the star asks, main keeps or forgets the page in
   * its file and answers, and this stores the answer. Painting the press instead would
   * let the star claim a page is saved when the write failed — the same failure the
   * dark-mode button had, and the reason both are `invoke` + answer.
   */
  setBookmarked(on: boolean): void {
    if (this.bookmarked === on) return
    this.bookmarked = on
    this.renderBookmark()
  }

  private renderBookmark(): void {
    // The glyph is the state: a hollow star means "not saved", a filled one means
    // "saved", so the button answers at a glance without a tooltip.
    this.bookmarkButton.textContent = this.bookmarked ? '★' : '☆'
    this.bookmarkButton.classList.toggle('active', this.bookmarked)
    this.bookmarkButton.setAttribute('aria-pressed', this.bookmarked ? 'true' : 'false')
    this.bookmarkButton.title = this.bookmarked ? 'Saved — click to remove this bookmark' : 'Bookmark this page'
  }

  private renderTitle(): void {
    const label = displayTitle(this.title, this.url)
    this.labelEl.textContent = label
    this.titleEl.title = `${label}\n${this.url}`
    this.faviconEl.textContent = faviconLetter(this.url)
    this.faviconEl.style.setProperty('--hue', String(hueFor(this.url)))
  }

  /**
   * The container pill. A shared-jar tile has none: badging `persist:main` would
   * put a label on almost every tile and say nothing. Colour carries the one fact
   * that matters at a glance — blue/slate jar survives a restart, amber jar is
   * gone at quit — and the text names it.
   */
  private renderContainer(): void {
    const partition = this.partition
    const label = partition === undefined ? null : containerLabel(partition)
    if (partition === undefined || label === null) {
      this.badgeEl.hidden = true
      this.badgeEl.textContent = ''
      this.badgeEl.removeAttribute('data-container')
      this.badgeEl.removeAttribute('title')
      return
    }
    const persistent = isPersistentPartition(partition)
    this.badgeEl.hidden = false
    this.badgeEl.textContent = label
    this.badgeEl.dataset.container = label
    this.badgeEl.classList.toggle('temp', !persistent)
    this.badgeEl.title = persistent
      ? `Container ${label} — persistent (${partition})`
      : `Container ${label} — in memory, dropped at quit (${partition})`
  }

  private wireEvents(): void {
    this.el.addEventListener('pointerdown', (event) => this.hooks.focus(this.id, { shift: event.shiftKey }), { capture: false })

    // The dots sit inside the drag handle. A press on one must not start a drag
    // or reach the title bar at all, so it is stopped here rather than filtered
    // out later in the chrome handler.
    const lights = must<HTMLSpanElement>(this.el, '[data-role="lights"]')
    for (const type of ['pointerdown', 'mousedown', 'pointerup'] as const) {
      lights.addEventListener(type, (event) => event.stopPropagation())
    }

    this.chrome.addEventListener('pointerdown', (event) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('button, [data-role="corner"]')) return
      this.beginDrag(event, 'move')
    })

    for (const grip of this.el.querySelectorAll<HTMLElement>('[data-role="corner"]')) {
      grip.addEventListener('pointerdown', (event) => this.beginDrag(event, 'resize'))
    }

    this.el.addEventListener('pointermove', (event) => this.onPointerMove(event))
    this.el.addEventListener('pointerup', (event) => this.endDrag(event))
    this.el.addEventListener('pointercancel', (event) => this.endDrag(event))

    must<HTMLButtonElement>(this.el, '[data-role="close"]').addEventListener('click', (event) => {
      event.stopPropagation()
      this.hooks.close(this.id)
    })
    must<HTMLButtonElement>(this.el, '[data-role="collapse"]').addEventListener('click', (event) => {
      event.stopPropagation()
      this.toggleCollapse()
    })
    must<HTMLButtonElement>(this.el, '[data-role="fit"]').addEventListener('click', (event) => {
      event.stopPropagation()
      this.fitInView()
    })
    must<HTMLButtonElement>(this.el, '[data-role="reload"]').addEventListener('click', (event) => {
      event.stopPropagation()
      this.hooks.command(this.id, 'reload')
    })
    this.backButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.hooks.command(this.id, 'back')
    })
    this.forwardButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.hooks.command(this.id, 'forward')
    })
    // Both are tile-level actions rather than page navigation. The press is stopped on
    // the button so it cannot reach the title bar's drag handler; the frame still sees it
    // through the chrome's own bubble, which is what raises the tile like any press.
    this.darkButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.hooks.toggleDark(this.id)
    })
    this.clipButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.hooks.clip(this.id)
    })
    this.bookmarkButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.hooks.toggleBookmark(this.id)
    })
  }

  private beginDrag(event: PointerEvent, mode: DragMode): void {
    if (event.button !== 0) return
    event.preventDefault()
    // Report the press before stopping it. The title bar is a drag region and this
    // handler stops the event, so the frame's own `pointerdown` listener — the one
    // that raises and selects — never sees a press that starts on the bar. Without
    // this call the only pressable part of a tile would drag without ever coming to
    // the front, which is the opposite of what the layer order claims.
    this.hooks.focus(this.id, { shift: event.shiftKey })
    event.stopPropagation()
    // A drag or resize is a statement that the collapsed state is finished.
    this.el.classList.remove('collapsed')
    this.restoreHeight = null
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...this.world },
      mode,
      corner: (event.target as HTMLElement | null)?.dataset.corner as Corner | undefined,
      shift: event.shiftKey,
      moved: false,
    }
    // The canvas owns what a move drags — this tile alone, or every selected tile
    // — and freezes the origins, so this class stops writing `world` in move mode.
    // One owner, and a dropped move event cannot drift the group.
    if (mode === 'move') this.hooks.beginMove(this.id)
    // Best-effort: a refused capture (pointer already gone) must not skip the
    // class that drives the visual drag state.
    capturePointer(this.el, event.pointerId)
    this.el.classList.add(mode === 'move' ? 'dragging' : 'resizing')
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag
    if (!drag || drag.pointerId !== event.pointerId) return
    const zoom = this.hooks.zoom() || 1
    const dx = (event.clientX - drag.startX) / zoom
    const dy = (event.clientY - drag.startY) / zoom
    if (
      !drag.moved &&
      (Math.abs(event.clientX - drag.startX) > DRAG_SLOP_PX || Math.abs(event.clientY - drag.startY) > DRAG_SLOP_PX)
    ) {
      drag.moved = true
    }

    if (drag.mode === 'move') {
      // Delegated: the canvas applies the delta to every tile it froze on press,
      // this one included, always from the press-time rects.
      this.hooks.moveBy(this.id, dx, dy)
    } else {
      // Free resize from the grabbed corner, anchored at the opposite one. The
      // minimum is 320x240 world units; `resizeFree` pins the moving edge rather
      // than letting the rect flip through its own anchor.
      this.restoreHeight = null
      this.el.classList.remove('collapsed')
      this.world = resizeFree(
        drag.origin,
        drag.corner ?? 'se',
        dx,
        dy,
        MIN_TILE_WORLD_W,
        MIN_TILE_WORLD_H,
      )
    }
    this.hooks.requestFrame()
  }

  private endDrag(event: PointerEvent): void {
    const drag = this.drag
    if (!drag || drag.pointerId !== event.pointerId) return
    this.drag = null
    this.el.classList.remove('dragging', 'resizing')
    releasePointer(this.el, event.pointerId)
    if (drag.mode === 'move') {
      this.hooks.endMove()
      // A press that never moved is a click. Selection is settled here rather
      // than on press: toggling on press would make a shift+drag unselect the
      // very tile it is about to carry.
      if (!drag.moved) this.hooks.click(this.id, { shift: drag.shift })
    }
    this.hooks.changed(this.id)
    this.hooks.requestFrame()
  }
}
