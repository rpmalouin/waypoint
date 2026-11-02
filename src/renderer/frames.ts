import { MIN_FRAME_WORLD_H, MIN_FRAME_WORLD_W } from '../shared/constants.ts'
import { DEFAULT_FRAME_COLOR, FRAME_COLORS, isFrameColor } from '../shared/frame-color.ts'
import { resizeFree, translateRect, worldToScreen } from '../shared/math.ts'
import type { FrameRecord, Rect, Viewport } from '../shared/types.ts'
import { capturePointer, releasePointer } from './pointer.ts'

export interface FrameHooks {
  /** Coalesce into the canvas rAF pipeline; never move a view from a raw event. */
  requestFrame: () => void
  zoom: () => number
  /**
   * Snapshot the tiles whose centres the zone holds, so a drag carries the same
   * set from press to release: a tile cannot pop in or out mid-gesture.
   */
  beginCarry: (world: Rect) => void
  /** Move the carried tiles by a world delta measured from that snapshot. */
  carryBy: (dx: number, dy: number) => void
  endCarry: () => void
  /** The gesture finished: this is the state worth saving. */
  commit: () => void
  rename: (id: string, name: string) => void
  /** The header's ✕ was pressed: drop the zone from the canvas. */
  remove: (id: string) => void
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  origin: Rect
  mode: 'move' | 'resize'
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (!found) throw new Error(`frame markup is missing ${selector}`)
  return found
}

/**
 * One named zone in the canvas background DOM.
 *
 * A frame is an annotation, not a container: it paints *behind* every tile's
 * `WebContentsView`, so its body is deliberately `pointer-events: none` — the
 * canvas behind it must stay pannable. Only the header (drag, rename) and the
 * corner handle take the pointer.
 */
export class Frame {
  readonly id: string
  readonly el: HTMLDivElement
  world: Rect
  name: string
  /**
   * The tint this zone wears, or undefined for none. Written into `--frame-color`
   * by `applyColor()` and into the workspace file by `record()`; mutable because
   * the swatch row is the one control that changes a frame after it is drawn.
   */
  color?: string

  private readonly head: HTMLElement
  private readonly nameEl: HTMLSpanElement
  private readonly resizeEl: HTMLElement
  private readonly colorEl: HTMLButtonElement
  private readonly swatchesEl: HTMLElement
  private drag: DragState | null = null

  constructor(
    record: FrameRecord,
    private readonly hooks: FrameHooks,
  ) {
    this.id = record.id
    this.name = record.name
    this.color = record.color
    this.world = { x: record.worldX, y: record.worldY, width: record.worldW, height: record.worldH }

    this.el = document.createElement('div')
    this.el.className = 'frame'
    this.el.dataset.frameId = record.id
    this.el.innerHTML = `
      <header class="frame-head" data-role="head" title="Drag to move this zone · double-click the name to rename">
        <button class="frame-color" data-role="color" type="button" title="Zone colour" aria-label="Zone colour" aria-haspopup="true"></button>
        <span class="frame-name" data-role="name"></span>
        <button class="frame-close" data-role="close" type="button" title="Remove this zone" aria-label="Remove zone">✕</button>
      </header>
      <div class="frame-swatches" data-role="swatches" hidden></div>
      <span class="frame-resize" data-role="resize" title="Resize zone"></span>
    `
    this.head = must(this.el, '[data-role="head"]')
    this.nameEl = must(this.el, '[data-role="name"]')
    this.resizeEl = must(this.el, '[data-role="resize"]')
    this.colorEl = must(this.el, '[data-role="color"]')
    this.swatchesEl = must(this.el, '[data-role="swatches"]')
    // Built from the one palette the loader validates against, so a swatch can
    // never offer a value the workspace save would then refuse.
    this.swatchesEl.innerHTML =
      '<button class="frame-swatch none current" data-color="none" type="button" title="No colour" aria-label="No colour"></button>' +
      FRAME_COLORS.map(
        (color) =>
          `<button class="frame-swatch" data-color="${color}" type="button" style="background:${color}" title="${color}" aria-label="${color}"></button>`,
      ).join('')
    this.renderName()
    this.applyColor()
    this.wireEvents()
  }

  applyLayout(viewport: Viewport): void {
    // Same edge rounding as the tiles, so a zone border does not sit a pixel off
    // the tile edges that are supposed to line up inside it.
    const screen = worldToScreen(this.world, viewport)
    this.el.style.transform = `translate3d(${screen.x}px, ${screen.y}px, 0)`
    this.el.style.width = `${screen.width}px`
    this.el.style.height = `${screen.height}px`
    this.el.style.setProperty('--zoom', String(viewport.zoom))
  }

  /** The record written to the workspace file. */
  record(): FrameRecord {
    return {
      id: this.id,
      name: this.name,
      worldX: Math.round(this.world.x),
      worldY: Math.round(this.world.y),
      worldW: Math.round(this.world.width),
      worldH: Math.round(this.world.height),
      ...(this.color ? { color: this.color } : {}),
    }
  }

  /**
   * Set the zone's tint, or clear it with null. Returns true when something
   * actually changed, so a repeat press does not dirty the canvas.
   *
   * The value is validated here as well as in the loader: the swatch row is built
   * from `FRAME_COLORS`, but this method writes into a CSS custom property, so it
   * does not trust its caller either.
   */
  setColor(color: string | null): boolean {
    if (color !== null && !isFrameColor(color)) return false
    const next = color === null ? undefined : color.toLowerCase()
    if (next === this.color) return false
    this.color = next
    this.applyColor()
    return true
  }

  /**
   * Paint the current tint. The property is always set — to the default when the
   * zone names no colour — because the stylesheet reads it for the border, the
   * background and the header dot: an absent value and a broken one would
   * otherwise look identical.
   */
  private applyColor(): void {
    this.el.style.setProperty('--frame-color', this.color ?? DEFAULT_FRAME_COLOR)
    this.colorEl.classList.toggle('custom', this.color !== undefined)
    this.colorEl.title = this.color ? `Zone colour ${this.color}` : 'Zone colour (default)'
    const current = this.color ?? 'none'
    for (const swatch of this.swatchesEl.querySelectorAll<HTMLElement>('[data-color]')) {
      swatch.classList.toggle('current', (swatch.dataset.color ?? 'none') === current)
    }
  }

  private toggleSwatches(): void {
    this.swatchesEl.hidden = !this.swatchesEl.hidden
    this.colorEl.classList.toggle('active', !this.swatchesEl.hidden)
  }

  private closeSwatches(): void {
    this.swatchesEl.hidden = true
    this.colorEl.classList.remove('active')
  }

  private renderName(): void {
    this.nameEl.textContent = this.name
    this.head.title = `${this.name} · drag to move · double-click to rename`
  }

  private wireEvents(): void {
    this.head.addEventListener('pointerdown', (event) => this.beginDrag(event, 'move'))
    this.resizeEl.addEventListener('pointerdown', (event) => this.beginDrag(event, 'resize'))

    // Both buttons live inside the header, which starts a drag on pointerdown:
    // stop it there or pressing ✕ would also move the zone under the cursor.
    const close = must<HTMLButtonElement>(this.el, '[data-role="close"]')
    close.addEventListener('pointerdown', (event) => event.stopPropagation())
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      this.hooks.remove(this.id)
    })

    // The colour control is the header dot: one 8px circle, so the header keeps
    // its width and the tint it shows is the tint it sets.
    this.colorEl.addEventListener('pointerdown', (event) => event.stopPropagation())
    this.colorEl.addEventListener('click', (event) => {
      event.stopPropagation()
      this.toggleSwatches()
    })
    this.colorEl.addEventListener('dblclick', (event) => event.stopPropagation())

    for (const swatch of this.swatchesEl.querySelectorAll<HTMLButtonElement>('[data-color]')) {
      // The swatches sit inside the zone but outside the header; stop the press
      // anyway so a future header-wide handler cannot drag the zone from here.
      swatch.addEventListener('pointerdown', (event) => event.stopPropagation())
      swatch.addEventListener('click', (event) => {
        event.stopPropagation()
        const value = swatch.dataset.color ?? 'none'
        this.setColor(value === 'none' ? null : value)
        this.closeSwatches()
        // Colour is part of the canvas state: mark it as the state worth saving.
        this.hooks.commit()
      })
    }

    this.head.addEventListener('dblclick', (event) => {
      // A double-click on either button must not open the rename field.
      if ((event.target as Element | null)?.closest('[data-role="close"], [data-role="color"]')) return
      event.stopPropagation()
      this.startRename()
    })

    this.el.addEventListener('pointermove', (event) => this.onPointerMove(event))
    this.el.addEventListener('pointerup', (event) => this.endDrag(event))
    this.el.addEventListener('pointercancel', (event) => this.endDrag(event))
  }

  /** Swap the label for an input; Enter or blur commits, Escape reverts. */
  private startRename(): void {
    if (this.drag) return
    const input = document.createElement('input')
    input.className = 'frame-name-input'
    input.value = this.name
    input.spellcheck = false
    this.nameEl.replaceWith(input)
    input.focus()
    input.select()

    let settled = false
    const finish = (commit: boolean): void => {
      if (settled) return
      settled = true
      const next = input.value.trim()
      input.replaceWith(this.nameEl)
      if (commit && next !== '' && next !== this.name) {
        this.name = next.slice(0, 64)
        this.hooks.rename(this.id, this.name)
        this.hooks.commit()
      }
      this.renderName()
    }

    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
    // The header would otherwise start a drag under the caret.
    input.addEventListener('pointerdown', (event) => event.stopPropagation())
  }

  private beginDrag(event: PointerEvent, mode: 'move' | 'resize'): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    // A drag of the zone cancels an open swatch row: the press means "move this",
    // and a picker left floating behind a moving zone reads as a stuck control.
    this.closeSwatches()
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...this.world },
      mode,
    }
    if (mode === 'move') this.hooks.beginCarry(this.world)
    // Capture last and best-effort: the gesture is already armed, and a refused
    // capture must not skip the carry snapshot or the moving class.
    capturePointer(this.el, event.pointerId)
    this.el.classList.add(mode === 'move' ? 'moving' : 'resizing')
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag
    if (!drag || drag.pointerId !== event.pointerId) return
    const zoom = this.hooks.zoom() || 1
    const dx = (event.clientX - drag.startX) / zoom
    const dy = (event.clientY - drag.startY) / zoom

    if (drag.mode === 'move') {
      this.world = translateRect(drag.origin, dx, dy)
      this.hooks.carryBy(dx, dy)
    } else {
      this.world = resizeFree(drag.origin, 'se', dx, dy, MIN_FRAME_WORLD_W, MIN_FRAME_WORLD_H)
    }
    this.hooks.requestFrame()
  }

  private endDrag(event: PointerEvent): void {
    const drag = this.drag
    if (!drag || drag.pointerId !== event.pointerId) return
    this.drag = null
    this.el.classList.remove('moving', 'resizing')
    releasePointer(this.el, event.pointerId)
    if (drag.mode === 'move') this.hooks.endCarry()
    this.hooks.commit()
    this.hooks.requestFrame()
  }
}
