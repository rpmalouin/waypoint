import type { ActionResult, CanvasStatus, OverlayAction, OverlayConfig } from '../../shared/types.ts'
import { escapeHtml, must } from './dom.ts'

export interface HudContext {
  act: (action: OverlayAction) => Promise<ActionResult>
  sendPanDelta: (dx: number, dy: number) => void
}

interface Drag {
  pointerId: number
  lastX: number
  lastY: number
}

/**
 * The main overlay region. It is the only view that is ever allowed to cover
 * the window, and it does so for one reason: the pan interceptor. In compact
 * mode the view is a 300x44 box in the top-right corner, so everything here
 * must fit that box as well as the full-window modal layout.
 */
export function mountHud(
  root: HTMLElement,
  ctx: HudContext,
): (config: OverlayConfig, status: CanvasStatus | null) => void {
  root.innerHTML = `
    <div id="pan-interceptor" data-role="interceptor" aria-hidden="true"></div>
    <div id="hud-slot"></div>
  `

  const slot = must<HTMLDivElement>(root, '#hud-slot')
  const interceptor = must<HTMLDivElement>(root, '#pan-interceptor')

  let mode: OverlayConfig['mode'] = 'compact'
  let current: OverlayConfig | null = null
  let currentStatus: CanvasStatus | null = null
  let workspacesKey = ''
  let drag: Drag | null = null
  let error = ''

  /** Every action reports its own failure; the modal shows it and re-renders. */
  const run = (action: OverlayAction): void => {
    void ctx.act(action).then((result) => {
      if (result.ok) return
      error = result.error ?? 'action failed'
      if (current) renderSlot(current, currentStatus)
    })
  }

  // ------------------------------------------------------------ interceptor

  const endDrag = (): void => {
    if (!drag) return
    drag = null
    interceptor.classList.remove('grabbing')
    document.body.classList.remove('grabbing')
  }

  interceptor.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.button !== 1) return
    event.preventDefault()
    drag = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
    interceptor.setPointerCapture(event.pointerId)
    interceptor.classList.add('grabbing')
    document.body.classList.add('grabbing')
  })

  interceptor.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    // Deltas only: the canvas owns the viewport and must apply them through its
    // rAF pipeline rather than have the overlay guess at positions.
    ctx.sendPanDelta(event.clientX - drag.lastX, event.clientY - drag.lastY)
    drag.lastX = event.clientX
    drag.lastY = event.clientY
  })

  for (const type of ['pointerup', 'pointercancel'] as const) {
    interceptor.addEventListener(type, (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return
      if (interceptor.hasPointerCapture(event.pointerId)) interceptor.releasePointerCapture(event.pointerId)
      endDrag()
    })
  }

  // ------------------------------------------------------------ compact HUD

  function metricText(config: OverlayConfig, status: CanvasStatus | null): string {
    const zoom = Math.round((status?.zoom ?? config.zoom ?? 1) * 100)
    const tiles = status?.tiles ?? config.tiles.length
    return `${zoom}% · ${tiles} tile${tiles === 1 ? '' : 's'}`
  }

  function renderCompact(config: OverlayConfig, status: CanvasStatus | null): void {
    slot.innerHTML = `
      <button class="hud" data-role="hud" type="button">
        <span class="dot" aria-hidden="true"></span>
        <span class="name">${escapeHtml(config.current)}</span>
        <span class="meta" data-role="metric">${metricText(config, status)}</span>
        <span class="chev" aria-hidden="true">▾</span>
      </button>
    `
    must<HTMLButtonElement>(slot, '[data-role="hud"]').addEventListener('click', () => {
      run({ kind: 'open-workspaces' })
    })
  }

  function paintCompact(config: OverlayConfig, status: CanvasStatus | null): void {
    const metric = slot.querySelector<HTMLElement>('[data-role="metric"]')
    if (!metric) {
      renderCompact(config, status)
      return
    }
    metric.textContent = metricText(config, status)
    const name = slot.querySelector<HTMLElement>('.name')
    if (name) name.textContent = config.current
  }

  // ------------------------------------------------------------- workspaces

  function renderWorkspaces(config: OverlayConfig): void {
    const names = config.workspaces
    const list =
      names.length === 0
        ? '<li class="empty">No saved workspaces yet — save this one to start.</li>'
        : names
            .map(
              (name) => `
        <li>
          <button class="ws ${name === config.current ? 'current' : ''}" data-ws="${escapeHtml(name)}" type="button">
            <span>${escapeHtml(name)}</span>
            ${name === config.current ? '<span class="badge">current</span>' : ''}
          </button>
        </li>`,
            )
            .join('')

    slot.innerHTML = `
      <div class="scrim" data-role="scrim">
        <div class="panel" role="dialog" aria-label="Workspaces">
          <header class="panel-head">
            <span>Workspaces</span>
            <span class="meta">${names.length} saved locally</span>
          </header>
          <form class="save-row" data-role="save-form">
            <input data-role="save-name" value="${escapeHtml(config.current)}" spellcheck="false" autocomplete="off" aria-label="Workspace name" />
            <button type="submit">Save current</button>
          </form>
          <ul class="ws-list" data-role="list">${list}</ul>
          <p class="hint">Enter saves as the typed name · click to switch · Esc closes</p>
          ${error ? `<p class="error" data-role="error">${escapeHtml(error)}</p>` : ''}
        </div>
      </div>
    `

    const scrim = must<HTMLElement>(slot, '[data-role="scrim"]')
    scrim.addEventListener('click', (event) => {
      if (event.target === scrim) run({ kind: 'collapse' })
    })

    const form = must<HTMLFormElement>(slot, '[data-role="save-form"]')
    const input = must<HTMLInputElement>(slot, '[data-role="save-name"]')
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (!input.value.trim()) {
        error = 'type a name first'
        renderWorkspaces(config)
        return
      }
      run({ kind: 'save', name: input.value })
    })

    for (const button of slot.querySelectorAll<HTMLButtonElement>('[data-ws]')) {
      button.addEventListener('click', () => {
        const name = button.dataset.ws ?? ''
        if (name) run({ kind: 'switch', name })
      })
    }

    input.focus()
    input.select()
  }

  // ---------------------------------------------------------------- omnibox

  function renderOmnibox(): void {
    slot.innerHTML = `
      <div class="scrim" data-role="scrim">
        <div class="panel omnibox" role="dialog" aria-label="Open a tile">
          <div class="panel-head">
            <span>New tile</span>
            <span class="meta">opens where you clicked</span>
          </div>
          <input data-role="omnibox" placeholder="URL, host, or search…" spellcheck="false" autocomplete="off" aria-label="URL" />
          <p class="hint">Enter opens · <code>@work &lt;url&gt;</code> opens a container · Esc cancels</p>
          ${error ? `<p class="error" data-role="error">${escapeHtml(error)}</p>` : ''}
        </div>
      </div>
    `

    const scrim = must<HTMLElement>(slot, '[data-role="scrim"]')
    scrim.addEventListener('click', (event) => {
      if (event.target === scrim) run({ kind: 'collapse' })
    })

    const input = must<HTMLInputElement>(slot, '[data-role="omnibox"]')
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key !== 'Enter') return
      if (!input.value.trim()) return
      run({ kind: 'create', input: input.value })
    })
    input.focus()
  }

  // ----------------------------------------------------------------- render

  function renderSlot(config: OverlayConfig, status: CanvasStatus | null): void {
    if (config.mode === 'omnibox') {
      renderOmnibox()
      return
    }
    if (config.mode === 'workspaces') {
      workspacesKey = config.workspaces.join('\u0000')
      renderWorkspaces(config)
      return
    }
    renderCompact(config, status)
  }

  function update(config: OverlayConfig, status: CanvasStatus | null): void {
    document.body.dataset.mode = config.mode
    document.body.dataset.region = 'main'

    if (config.mode !== 'pan') endDrag()

    const nextWorkspacesKey = config.workspaces.join('\u0000')
    const needsRebuild =
      config.mode !== mode ||
      (config.mode === 'workspaces' && nextWorkspacesKey !== workspacesKey) ||
      (config.mode !== 'compact' && error !== '' && !slot.querySelector('[data-role="error"]'))

    if (needsRebuild) {
      mode = config.mode
      renderSlot(config, status)
      return
    }

    if (config.mode === 'compact') {
      paintCompact(config, status)
      error = ''
    }
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (mode === 'compact') return
    error = ''
    run({ kind: 'collapse' })
  })

  return (config, status) => {
    current = config
    currentStatus = status
    try {
      update(config, status)
    } catch (failure) {
      // A chrome render bug must not blank the window.
      console.error('[hud] render failed:', failure)
    }
  }
}
