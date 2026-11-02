import { classifyWheel } from '../shared/math.ts'
import type { Point, Rect } from '../shared/types.ts'
import { capturePointer, releasePointer } from './pointer.ts'

export interface InputApi {
  pan: (dx: number, dy: number) => void
  zoomAt: (point: Point, factor: number) => void
  openPalette: (screenPoint?: Point) => void
  collapsePalette: () => void
  saveWorkspace: () => void
  /** ⌘N or ⌘L: put the caret in the dock's omnibox. */
  openDock: () => void
  /** ⌘\: slide the sidebar in or out. */
  toggleSidebar: () => void
  clearSelection: () => void
  /**
   * The rubberband's live hit test, called on every move of a background drag: the
   * box in screen pixels, and whether the selection should be unioned (shift).
   */
  marquee: (screenRect: Rect, additive: boolean) => void
  fitAll: () => void
  /** ⌘G: draw a group frame around the selection (or everything). */
  drawFrame: () => void
}

/**
 * Screen pixels the box must span before it counts as a rubberband. Below it the
 * gesture is the background click it looks like, and the press has already cleared
 * the selection — a 1px twitch must not re-run a hit test over nothing.
 */
const MARQUEE_SLOP_PX = 3

/** True when the event came from somewhere that owns its own keystrokes. */
function isEditing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable
}

export function installInput(container: HTMLElement, api: InputApi): void {
  let panning: { pointerId: number; lastX: number; lastY: number } | null = null
  let rubberband: { pointerId: number; startX: number; startY: number; additive: boolean } | null = null

  /**
   * The box is created here rather than in `index.html` because it exists only
   * while this gesture module is installed, and it is never a target: the element
   * is `pointer-events: none`, so it can be drawn over a tile's chrome without
   * stealing the drag that is producing it.
   */
  const marqueeEl = document.createElement('div')
  marqueeEl.id = 'selection-marquee'
  marqueeEl.hidden = true
  container.append(marqueeEl)

  const drawMarquee = (event: PointerEvent): Rect | null => {
    const box = rubberband
    if (!box) return null
    const rect: Rect = {
      x: Math.min(box.startX, event.clientX),
      y: Math.min(box.startY, event.clientY),
      width: Math.abs(event.clientX - box.startX),
      height: Math.abs(event.clientY - box.startY),
    }
    marqueeEl.hidden = false
    marqueeEl.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`
    marqueeEl.style.width = `${rect.width}px`
    marqueeEl.style.height = `${rect.height}px`
    return rect
  }

  const stopMarquee = (event: PointerEvent): void => {
    if (!rubberband || rubberband.pointerId !== event.pointerId) return
    rubberband = null
    marqueeEl.hidden = true
    releasePointer(container, event.pointerId)
  }

  container.addEventListener(
    'wheel',
    (event) => {
      // Always ours: the canvas owns zoom and pan on zoomable content.
      event.preventDefault()
      const intent = classifyWheel(event)
      if (intent.kind === 'zoom') api.zoomAt({ x: event.clientX, y: event.clientY }, intent.factor)
      else api.pan(intent.dx, intent.dy)
    },
    { passive: false },
  )

  container.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('.tile')) return
    // Clicking bare canvas drops the selection; the dock and the sidebar follow
    // through the inventory the renderer pushes on every change. Shift keeps it,
    // because a shift drag is an additive rubberband.
    if (!event.shiftKey) api.clearSelection()
    // Middle-drag pans. The left button belongs to selection (and, over a tile's
    // page, to the page): a key never turns a left press into a pan.
    if (event.button === 1) {
      event.preventDefault()
      panning = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
      container.classList.add('panning')
      container.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0) return
    // Bare canvas, left button, not panning: the rubberband. Armed first, captured
    // last and best-effort, so a refused capture cannot disarm the gesture.
    rubberband = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      additive: event.shiftKey,
    }
    capturePointer(container, event.pointerId)
  })

  container.addEventListener('pointermove', (event) => {
    if (rubberband && rubberband.pointerId === event.pointerId) {
      const rect = drawMarquee(event)
      // Below the slop the gesture is the background click the press already
      // handled, so nothing is re-tested and no box is left on screen.
      if (rect && (rect.width >= MARQUEE_SLOP_PX || rect.height >= MARQUEE_SLOP_PX)) {
        api.marquee(rect, rubberband.additive)
      }
      return
    }
    if (!panning || panning.pointerId !== event.pointerId) return
    api.pan(event.clientX - panning.lastX, event.clientY - panning.lastY)
    panning.lastX = event.clientX
    panning.lastY = event.clientY
  })

  const stopPan = (event: PointerEvent): void => {
    if (!panning || panning.pointerId !== event.pointerId) return
    panning = null
    container.classList.remove('panning')
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId)
  }
  container.addEventListener('pointerup', (event) => {
    stopPan(event)
    stopMarquee(event)
  })
  container.addEventListener('pointercancel', (event) => {
    stopPan(event)
    stopMarquee(event)
  })

  container.addEventListener('dblclick', (event) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('.tile')) return
    api.openPalette({ x: event.clientX, y: event.clientY })
  })

  window.addEventListener('keydown', (event) => {
    if (isEditing(event.target)) return

    const key = event.key.toLowerCase()
    if (event.metaKey && key === 's') {
      event.preventDefault()
      api.saveWorkspace()
      return
    }
    if (event.metaKey && key === '\\') {
      event.preventDefault()
      api.toggleSidebar()
      return
    }
    if (event.metaKey && (key === 'n' || key === 'k' || key === 'l')) {
      event.preventDefault()
      api.openDock()
      return
    }
    // ⌘B is the alias people try first; ⌘\ is the one on the tooltips.
    if (event.metaKey && key === 'b') {
      event.preventDefault()
      api.toggleSidebar()
      return
    }
    if (event.metaKey && key === 'g') {
      event.preventDefault()
      api.drawFrame()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return

    if (key === 'n') {
      event.preventDefault()
      api.openPalette()
    } else if (key === 'f') {
      event.preventDefault()
      api.fitAll()
    } else if (event.key === 'Escape') {
      api.collapsePalette()
      api.clearSelection()
    }
  })

  // Losing focus mid-gesture must not leave the canvas stuck in pan mode, or a
  // selection box frozen on screen.
  window.addEventListener('blur', () => {
    panning = null
    rubberband = null
    marqueeEl.hidden = true
    container.classList.remove('panning')
  })
}
