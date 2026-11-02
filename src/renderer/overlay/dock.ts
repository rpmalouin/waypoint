import type { ActionResult, CanvasStatus, OverlayAction, OverlayConfig } from '../../shared/types.ts'
import { containerLabel } from '../../shared/session-partition.ts'
import { matchBookmarks } from '../../shared/bookmarks.ts'
import type { BookmarkRecord } from '../../shared/bookmarks.ts'
import { escapeHtml, must, splitClick } from './dom.ts'

export interface DockContext {
  act: (action: OverlayAction) => Promise<ActionResult>
  onDockFocus: (callback: (prefix?: string) => void) => () => void
}

/** True when the input is mid-prefix, i.e. a container suggestion is useful. */
function prefixOf(value: string): string | null {
  const typed = value.trim()
  if (typed === '') return null
  const at = /^@([A-Za-z0-9_-]*)$/.exec(typed)
  if (at) return at[1] ?? ''
  const colon = /^([A-Za-z0-9_-]+):$/.exec(typed)
  if (colon) return colon[1] ?? ''
  return null
}

/**
 * The floating bottom dock. It gets its own view so that only the dock's own
 * rectangle steals clicks from the canvas — a full-width strip of transparent
 * view would have made the bottom of the window unusable.
 *
 * Layout and position (bottom: 24px, centred, 56px tall) are applied by the main
 * process, which owns view bounds; this file only fills the rectangle it is given.
 */
export function mountDock(
  root: HTMLElement,
  ctx: DockContext,
): (config: OverlayConfig, status: CanvasStatus | null) => void {
  // Marks the page for this region: the views share one document, so anything
  // that inspects the DOM (or devtools) needs to be able to tell them apart.
  document.body.dataset.region = 'dock'
  root.innerHTML = `
    <div class="dock" data-role="dock">
      <button class="pill tool" data-role="tool" type="button" title="Select tool (V)">
        <span class="tool-glyph" data-role="glyph">▲</span>
      </button>
      <div class="omnibox-wrap">
        <span class="kbd" aria-hidden="true">⌘N</span>
        <input class="dock-omnibox" data-role="omnibox" placeholder="Search or enter address…" spellcheck="false" autocomplete="off" aria-label="Search or enter address" title="Search or enter address · @work or work: opens a container" />
        <button class="go" data-role="go" type="button" title="Open (Enter)">↵</button>
      </div>
      <div class="chips" data-role="chips" hidden></div>
      <button class="pill count" data-role="count" type="button" title="Tiles open · click to toggle the sidebar (⌘B)">0 tiles</button>
      <button class="pill zoom" data-role="zoom" type="button" title="Reset zoom to 100% · double-click to fit all tiles">100%</button>
      <button class="pill" data-role="fit" type="button" title="Fit to view (F)">⤢</button>
      <button class="pill" data-role="sidebar" type="button" title="Toggle sidebar (⌘B)">▤</button>
    </div>
    <span class="dock-error" data-role="error"></span>
  `

  const dock = must<HTMLElement>(root, '[data-role="dock"]')
  const tool = must<HTMLButtonElement>(root, '[data-role="tool"]')
  const glyph = must<HTMLElement>(root, '[data-role="glyph"]')
  const omnibox = must<HTMLInputElement>(root, '[data-role="omnibox"]')
  const go = must<HTMLButtonElement>(root, '[data-role="go"]')
  const chips = must<HTMLElement>(root, '[data-role="chips"]')
  const count = must<HTMLButtonElement>(root, '[data-role="count"]')
  const zoom = must<HTMLButtonElement>(root, '[data-role="zoom"]')
  const fit = must<HTMLButtonElement>(root, '[data-role="fit"]')
  const sidebar = must<HTMLButtonElement>(root, '[data-role="sidebar"]')
  const errorEl = must<HTMLElement>(root, '[data-role="error"]')

  let zoomText = ''
  let countText = ''
  let toolValue: OverlayConfig['tool'] | '' = ''
  let sidebarOpen: boolean | null = null
  let chipsKey = ''
  let latest: OverlayConfig | null = null
  let errorTimer = 0

  const fail = (result: ActionResult): void => {
    if (result.ok) return
    errorEl.textContent = result.error ?? 'action failed'
    errorEl.classList.add('visible')
    if (errorTimer !== 0) window.clearTimeout(errorTimer)
    errorTimer = window.setTimeout(() => {
      errorTimer = 0
      errorEl.classList.remove('visible')
    }, 4000)
  }

  const run = (action: OverlayAction): void => {
    void ctx.act(action).then(fail)
  }

  const submit = (): void => {
    const value = omnibox.value.trim()
    if (!value) return
    run({ kind: 'create', input: value })
    omnibox.value = ''
    omnibox.blur()
  }

  // ------------------------------------------------------- container chips

  /**
   * Containers to suggest: the ones already open, so a second tile joins a jar
   * that exists instead of inventing `wrok`, then `temp`. The list is capped
   * because the chip row shares the dock's single 56px line with the input.
   */
  const containerNames = (config: OverlayConfig): string[] => {
    const names: string[] = []
    for (const tile of config.tiles) {
      if (!tile.partition) continue
      const label = containerLabel(tile.partition)
      if (label === null || label === 'temp' || names.includes(label)) continue
      names.push(label)
    }
    names.push('temp')
    return names.slice(0, 5)
  }

  /**
   * Bookmark recall. Only when the user is typing an address: `@work` is a container
   * gesture first, and its chips share the same single line.
   *
   * The store shape is reconstructed rather than passed through because `matchBookmarks`
   * is the pure module a test holds to account; the config carries the records, not the
   * file.
   */
  const bookmarkMatches = (config: OverlayConfig, query: string): BookmarkRecord[] =>
    matchBookmarks({ version: 1, bookmarks: config.bookmarks }, query, 4)

  /** Rewrites the prefix in place, keeping whatever the user typed after it. */
  const applyChip = (name: string): void => {
    const value = omnibox.value
    const space = value.search(/\s/)
    const rest = space === -1 ? ' ' : value.slice(space)
    omnibox.value = `@${name}${rest}`
    omnibox.focus()
    omnibox.setSelectionRange(omnibox.value.length, omnibox.value.length)
    // Programmatic assignment fires no input event, so repaint by hand.
    paintSuggestions()
  }

  /** Launch a saved page. A suggestion row is a launcher, not a completion. */
  const openBookmark = (id: string): void => {
    if (!id) return
    run({ kind: 'open-bookmark', id })
    omnibox.value = ''
    omnibox.blur()
    paintSuggestions()
  }

  /**
   * The suggestion row is painted on the dock's own keystrokes as well as on a config
   * push: typing never reaches main, and waiting for the next status tick to answer a
   * keypress would read as a broken UI.
   *
   * Two kinds share the one line and never appear together — container chips while a
   * prefix is being typed, bookmark matches otherwise — because the dock is a 56px
   * strip and a second row is a second view.
   */
  function paintSuggestions(): void {
    if (!latest) return
    const prefix = prefixOf(omnibox.value)
    const query = omnibox.value.trim()
    const matches = prefix === null && query.length >= 2 ? bookmarkMatches(latest, query) : []
    const suggesting = matches.length > 0
    dock.classList.toggle('typing', prefix !== null || suggesting)
    chips.hidden = prefix === null && !suggesting
    if (chips.hidden) {
      chipsKey = ''
      return
    }

    if (prefix !== null) {
      const names = containerNames(latest)
      const key = `chip|${prefix}|${names.join('|')}`
      if (key === chipsKey) return
      chipsKey = key
      chips.innerHTML = names
        .map((name) => `<button class="chip" data-chip="${name}" type="button">@${name}</button>`)
        .join('')
      for (const button of chips.querySelectorAll<HTMLButtonElement>('[data-chip]')) {
        // Keep the caret in the input: a chip press is a completion, not a blur.
        button.addEventListener('mousedown', (event) => event.preventDefault())
        button.addEventListener('click', () => applyChip(button.dataset.chip ?? ''))
      }
      return
    }

    const key = `bookmark|${matches.map((record) => record.id).join('|')}`
    if (key === chipsKey) return
    chipsKey = key
    chips.innerHTML = matches
      .map(
        (record) =>
          `<button class="chip bookmark" data-bookmark="${escapeHtml(record.id)}" type="button" title="${escapeHtml(
            record.url,
          )}"><span class="chip-star" aria-hidden="true">★</span><span class="chip-name">${escapeHtml(
            record.title,
          )}</span></button>`,
      )
      .join('')
    for (const button of chips.querySelectorAll<HTMLButtonElement>('[data-bookmark]')) {
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => openBookmark(button.dataset.bookmark ?? ''))
    }
  }

  // --------------------------------------------------------------- controls

  tool.addEventListener('click', () => {
    // The pill is a toggle: latched pan arms the interceptor until it is clicked
    // again or Escape is pressed, which is the only way to pan across a dense
    // cluster of tile pages.
    run({ kind: 'set-tool', tool: toolValue === 'pan' ? 'select' : 'pan' })
  })

  // One click resets to 100%, a double-click fits every tile on screen. They are
  // different gestures on one control, so the single click has to be deferred.
  splitClick(
    zoom,
    () => run({ kind: 'zoom-reset' }),
    () => run({ kind: 'fit-view' }),
  )

  fit.addEventListener('click', () => run({ kind: 'fit-view' }))
  sidebar.addEventListener('click', () => run({ kind: 'toggle-sidebar' }))
  // The counter is a second way to summon the sidebar, which is what makes it
  // worth a pill: it answers "how many tiles?" and "where is the list?" at once.
  count.addEventListener('click', () => run({ kind: 'toggle-sidebar' }))
  go.addEventListener('click', submit)

  omnibox.addEventListener('input', paintSuggestions)
  omnibox.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
      return
    }
    if (event.key === 'Escape') {
      omnibox.value = ''
      omnibox.blur()
      paintSuggestions()
      return
    }
    // Tab accepts the first suggestion, and takes the two kinds differently: a container
    // chip is a prefix the user keeps typing after, while a bookmark is a whole address
    // — completing it is the half-way point that still leaves Enter to open it. Enter
    // itself always submits what is in the field, so a suggestion can never block the
    // address the user already typed.
    if (event.key === 'Tab' && !chips.hidden) {
      const chip = chips.querySelector<HTMLButtonElement>('[data-chip]')
      if (chip) {
        event.preventDefault()
        applyChip(chip.dataset.chip ?? '')
        return
      }
      const suggestion = chips.querySelector<HTMLButtonElement>('[data-bookmark]')
      const record = suggestion
        ? latest?.bookmarks.find((bookmark) => bookmark.id === suggestion.dataset.bookmark) ?? null
        : null
      if (record) {
        event.preventDefault()
        omnibox.value = record.url
        omnibox.setSelectionRange(record.url.length, record.url.length)
        paintSuggestions()
      }
    }
  })

  // ⌘N from anywhere in the app lands here; main tells this view to take focus.
  // A container pick arrives as a prefix (`@work `), so choosing a jar and typing
  // an address is one gesture — and the caret goes to the end, after the prefix,
  // rather than selecting text the user did not type.
  ctx.onDockFocus((prefix) => {
    if (prefix !== undefined) {
      omnibox.value = prefix
      // A programmatic assignment fires no input event, so repaint by hand.
      paintSuggestions()
    }
    omnibox.focus()
    if (prefix !== undefined) omnibox.setSelectionRange(omnibox.value.length, omnibox.value.length)
    else omnibox.select()
  })

  // This view owns the keyboard while the dock has focus, so the canvas's own
  // shortcut listener never sees these. Same keys, same meaning.
  document.addEventListener('keydown', (event) => {
    if (!event.metaKey || event.altKey || event.ctrlKey) return
    if (event.code === 'KeyL' || event.code === 'KeyN') {
      event.preventDefault()
      omnibox.focus()
      omnibox.select()
      return
    }
    if (event.code === 'KeyB' || event.code === 'Backslash') {
      event.preventDefault()
      run({ kind: 'toggle-sidebar' })
    }
  })

  // ----------------------------------------------------------------- render

  return (config: OverlayConfig, status: CanvasStatus | null): void => {
    try {
      const nextZoom = `${Math.round((status?.zoom ?? config.zoom ?? 1) * 100)}%`
      if (nextZoom !== zoomText) {
        zoomText = nextZoom
        zoom.textContent = nextZoom
      }

      const tileCount = status?.tiles ?? config.tiles.length
      const nextCount = `${tileCount} tile${tileCount === 1 ? '' : 's'}`
      if (nextCount !== countText) {
        countText = nextCount
        count.textContent = nextCount
      }

      if (config.tool !== toolValue) {
        toolValue = config.tool
        const pan = config.tool === 'pan'
        glyph.textContent = pan ? '✋' : '▲'
        tool.classList.toggle('active', pan)
        tool.title = pan ? 'Hand tool on — click for select' : 'Select tool (V)'
      }

      if (config.sidebarOpen !== sidebarOpen) {
        sidebarOpen = config.sidebarOpen
        sidebar.classList.toggle('active', config.sidebarOpen)
      }

      // Suggestions are painted from typed state; a config push only refreshes the
      // container list and the bookmark list they are built from.
      latest = config
      paintSuggestions()

      // Placeholder doubles as the omnibox hint; never overwrite what is typed.
      if (document.activeElement !== omnibox) {
        const placeholder = config.tiles.length === 0 ? 'Search or enter address…' : `Search · ${config.tiles.length} tile${config.tiles.length === 1 ? '' : 's'} open`
        if (omnibox.placeholder !== placeholder) omnibox.placeholder = placeholder
        if (omnibox.value !== '' && config.mode !== 'compact') {
          omnibox.value = ''
          // A programmatic clear fires no input event; keep the chips honest.
          paintSuggestions()
        }
      }

      document.title = `Dock · ${config.current}`
    } catch (failure) {
      console.error('[dock] render failed:', failure)
    }
  }
}
