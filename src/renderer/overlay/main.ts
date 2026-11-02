import './overlay.css'
import { DEFAULT_THEME } from '../../shared/theme.ts'
import type { WorkspaceTheme } from '../../shared/theme.ts'
import type { ActionResult, CanvasStatus, OverlayAction, OverlayConfig } from '../../shared/types.ts'
import { mountDock } from './dock.ts'
import { mountHud } from './hud.ts'
import { mountSidebar } from './sidebar.ts'

/**
 * One page, three views. Main loads this file with `#main`, `#dock` or
 * `#sidebar` and sizes the view to exactly that region, so the same bundle can
 * back three floating panels without any of them stealing clicks from the tiles
 * underneath that they do not actually cover.
 */
const bridge = window.overlayBridge
const root = document.getElementById('root') as HTMLElement

let config: OverlayConfig | null = null
let status: CanvasStatus | null = null

const act = (action: OverlayAction): Promise<ActionResult> => bridge.action(action)

let paint: (next: OverlayConfig, nextStatus: CanvasStatus | null) => void

switch (bridge.region) {
  case 'dock':
    paint = mountDock(root, { act, onDockFocus: bridge.onDockFocus })
    break
  case 'sidebar':
    paint = mountSidebar(root, { act, clearContainer: bridge.clearContainer })
    break
  default:
    paint = mountHud(root, { act, sendPanDelta: bridge.sendPanDelta })
}

bridge.onConfig((next) => {
  config = next
  paint(next, status)
})

bridge.onStatus((next) => {
  status = next
  if (config) paint(config, next)
})

/**
 * The chrome's half of the theme, set on `:root` so every region inherits it.
 *
 * A sibling `WebContentsView` cannot sample the pixels behind it, so there is no
 * blur to be had here: `backdrop-filter` would have nothing to filter. The glass is
 * a solid tint mixed from the theme's base stop, which is honest about what the
 * compositor can do and still reads as part of the same surface as the canvas.
 */
function applyTheme(theme: WorkspaceTheme): void {
  const style = document.documentElement.style
  const base = theme.colors[0] ?? DEFAULT_THEME.colors[0]!
  style.setProperty('--theme-base', base)
  style.setProperty('--theme-sidebar-tint', `color-mix(in srgb, ${base} 14%, #16181d)`)
  style.setProperty('--theme-dock-tint', `color-mix(in srgb, ${base} 18%, #1c1e24)`)
}

bridge.onTheme(applyTheme)

// Ask main for the current config; every region renders nothing until it arrives.
void act({ kind: 'init' }).then((result) => {
  if (!result.ok) console.error('[chrome] init failed:', result.error)
})
