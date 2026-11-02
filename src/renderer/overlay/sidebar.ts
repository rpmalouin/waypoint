import type { ActionResult, CanvasStatus, OverlayAction, OverlayConfig, TileSummary } from '../../shared/types.ts'
import { displayTitle, faviconLetter, hueFor } from '../../shared/math.ts'
import { hostOf } from '../../shared/adblock.ts'
import {
  DEFAULT_TILE_PARTITION,
  containerChoices,
  containerLabel,
  containerPrefix,
  isPersistentPartition,
  isTilePartition,
} from '../../shared/session-partition.ts'
import { escapeHtml, must } from './dom.ts'
import { mountThemeInspector } from './theme-inspector.ts'

export interface SidebarContext {
  act: (action: OverlayAction) => Promise<ActionResult>
  /**
   * Wipe one container's storage. It lives on the bridge rather than as an
   * `OverlayAction` because it is the one destructive capability the chrome has:
   * one channel, one handler, one place to read the rule (the shared jar is
   * refused in `clearContainerStorage()`).
   */
  clearContainer: (partition: string) => Promise<ActionResult>
}

/**
 * What the panels below the header are doing. A container panel is opened either
 * to pick a jar for the *next* tile, or to move an *open* tile into one; both
 * render the same list, so the two can never disagree about what exists.
 */
type ContainerPanel = { kind: 'pick' } | { kind: 'move'; id: string }

/**
 * The left sidebar, in its own view. When it collapses, main animates that view
 * down to a 44px rail, so this page has to be usable at both widths: the same
 * DOM renders the full panel or just the expand button, driven by the
 * `sidebarOpen` flag in the config.
 */
export function mountSidebar(
  root: HTMLElement,
  ctx: SidebarContext,
): (config: OverlayConfig, status: CanvasStatus | null) => void {
  document.body.dataset.region = 'sidebar'
  root.innerHTML = `
    <aside class="sidebar" data-role="sidebar">
      <header class="side-head">
        <button class="rail-toggle" data-role="collapse" type="button" title="Collapse sidebar (⌘B)">«</button>
        <button class="ws-picker" data-role="ws-picker" type="button" title="Switch workspace">
          <span class="ws-name" data-role="ws-name">scratch</span>
          <span class="ws-chev" aria-hidden="true">▾</span>
        </button>
        <button class="save-btn" data-role="save" type="button" title="Save workspace (⌘S)">⇩</button>
        <button class="ctr-btn" data-role="containers" type="button" title="Containers">⧉</button>
        <button class="bk-btn" data-role="bookmarks" type="button" title="Bookmarks">★</button>
        <button class="layer-btn" data-role="layers" type="button" title="Layer order">▤</button>
        <button class="theme-btn" data-role="theme" type="button" title="Theme">🎨</button>
      </header>
      <div class="ws-menu" data-role="ws-menu" hidden>
        <div class="ws-actions" data-role="ws-actions">
          <button class="ws-item" data-ws-action="rename" type="button">Rename…</button>
          <button class="ws-item" data-ws-action="duplicate" type="button">Duplicate</button>
          <button class="ws-item danger" data-ws-action="delete" type="button">Delete…</button>
        </div>
        <ul class="ws-items" data-role="ws-items"></ul>
        <p class="ws-hint">⌘S saves · ⌘B or ⌘\\ collapses</p>
      </div>
      <div class="ctr-menu" data-role="ctr-menu" hidden></div>
      <div class="bk-menu" data-role="bk-menu" hidden></div>
      <div class="layer-menu" data-role="layer-menu" hidden></div>
      <div class="theme-host" data-role="theme-host"></div>
      <ul class="tile-list" data-role="list"></ul>
      <p class="side-error" data-role="error" hidden></p>
      <footer class="side-foot">
        <span class="count" data-role="count">0 tiles</span>
        <span class="zoom" data-role="zoom">100%</span>
      </footer>
    </aside>
  `

  const aside = must<HTMLElement>(root, '[data-role="sidebar"]')
  const collapse = must<HTMLButtonElement>(root, '[data-role="collapse"]')
  const picker = must<HTMLButtonElement>(root, '[data-role="ws-picker"]')
  const wsName = must<HTMLElement>(root, '[data-role="ws-name"]')
  const save = must<HTMLButtonElement>(root, '[data-role="save"]')
  const containersBtn = must<HTMLButtonElement>(root, '[data-role="containers"]')
  const bookmarksBtn = must<HTMLButtonElement>(root, '[data-role="bookmarks"]')
  const layersBtn = must<HTMLButtonElement>(root, '[data-role="layers"]')
  const themeBtn = must<HTMLButtonElement>(root, '[data-role="theme"]')
  const themeHost = must<HTMLElement>(root, '[data-role="theme-host"]')
  // Mounted once: the panel is in flow, and every repaint below rewrites only the
  // list and the menus, so the controls keep whatever the user is dragging.
  const inspector = mountThemeInspector(themeHost)
  const menu = must<HTMLElement>(root, '[data-role="ws-menu"]')
  const ctrMenu = must<HTMLElement>(root, '[data-role="ctr-menu"]')
  const bkMenu = must<HTMLElement>(root, '[data-role="bk-menu"]')
  const layerMenu = must<HTMLElement>(root, '[data-role="layer-menu"]')
  const items = must<HTMLUListElement>(root, '[data-role="ws-items"]')
  const list = must<HTMLUListElement>(root, '[data-role="list"]')
  const count = must<HTMLElement>(root, '[data-role="count"]')
  const zoomEl = must<HTMLElement>(root, '[data-role="zoom"]')
  const renameBtn = must<HTMLButtonElement>(root, '[data-ws-action="rename"]')
  const duplicateBtn = must<HTMLButtonElement>(root, '[data-ws-action="duplicate"]')
  const deleteBtn = must<HTMLButtonElement>(root, '[data-ws-action="delete"]')

  let current: OverlayConfig | null = null
  let menuOpen = false
  let listKey = ''
  let menuKey = ''
  let open = true
  let renaming = false
  /** Set to the name awaiting a second Delete press. */
  let pendingDelete: string | null = null
  /** Non-null while the container panel is showing. */
  let panel: ContainerPanel | null = null
  /** Set to the partition awaiting a second Clear press. */
  let pendingClear: string | null = null
  let panelKey = ''
  /** True while the layer panel is showing — the fourth in-flow alternative. */
  let layerOpen = false
  let layerKey = ''
  /** True while the bookmark shelf is showing — the fifth alternative. */
  let bookmarkOpen = false
  let bookmarkKey = ''
  let errorTimer = 0

  const run = (action: OverlayAction): void => {
    void ctx.act(action)
  }

  /** Same as `run`, but a refusal is shown instead of swallowed. */
  const dispatch = (action: OverlayAction): void => {
    void ctx.act(action).then((result) => {
      if (!result.ok) showError(result.error ?? 'action failed')
    })
  }

  // Outside the menu on purpose: a workspace action closes the menu, so an error
  // rendered inside it would be hidden by the time it arrived. This line sits
  // above the footer, where it is always visible while the panel is open.
  const errorEl = must<HTMLElement>(root, '[data-role="error"]')
  function showError(message: string): void {
    errorEl.textContent = message
    errorEl.hidden = false
    if (errorTimer !== 0) window.clearTimeout(errorTimer)
    errorTimer = window.setTimeout(() => {
      errorTimer = 0
      errorEl.hidden = true
    }, 5000)
  }

  const closeMenu = (): void => {
    menuOpen = false
    menu.hidden = true
    pendingDelete = null
    deleteBtn.textContent = 'Delete…'
  }

  function renderMenu(config: OverlayConfig): void {
    const key = `${config.current}\u0000${config.workspaces.join('\u0000')}`
    if (key === menuKey) return
    menuKey = key
    items.innerHTML =
      '<li><button class="ws-item new" data-new="1" type="button">+ New workspace</button></li>' +
      (config.workspaces.length === 0
        ? '<li class="empty">Nothing saved yet</li>'
        : config.workspaces
            .map(
              (name) => `
        <li>
          <button class="ws-item ${name === config.current ? 'current' : ''}" data-ws="${escapeHtml(name)}" type="button">
            ${escapeHtml(name)}
          </button>
        </li>`,
            )
            .join(''))
    items.querySelector('[data-new]')?.addEventListener('click', () => {
      closeMenu()
      run({ kind: 'new-workspace' })
    })
    for (const button of items.querySelectorAll<HTMLButtonElement>('[data-ws]')) {
      button.addEventListener('click', () => {
        const name = button.dataset.ws ?? ''
        closeMenu()
        if (name) run({ kind: 'switch', name })
      })
    }
  }

  // ------------------------------------------------------- containers panel

  const closePanel = (): void => {
    panel = null
    pendingClear = null
    panelKey = ''
    ctrMenu.hidden = true
    ctrMenu.innerHTML = ''
    containersBtn.classList.remove('active')
  }

  const openPanel = (next: ContainerPanel): void => {
    closeMenu()
    closeBookmarks()
    panel = next
    pendingClear = null
    panelKey = ''
    containersBtn.classList.toggle('active', next.kind === 'pick')
    ctrMenu.hidden = false
    if (current) renderPanel(current)
  }

  /**
   * The panel is rebuilt only when its content changes — pending confirmations and
   * a changed container list are all in the key, so a status tick cannot wipe a
   * half-pressed Clear.
   */
  function renderPanel(config: OverlayConfig): void {
    const mode = panel
    if (mode === null) return
    const choices = containerChoices(config.tiles.map((tile) => tile.partition))
    const moving = mode.kind === 'move' ? config.tiles.find((tile) => tile.id === mode.id) ?? null : null
    if (mode.kind === 'move' && moving === null) {
      // The tile closed while the panel was open: nothing left to move.
      closePanel()
      return
    }
    const key = [
      mode.kind,
      mode.kind === 'move' ? mode.id : '',
      moving?.partition ?? '',
      pendingClear ?? '',
      choices.map((choice) => choice.partition).join('|'),
    ].join('\u0000')
    if (key === panelKey) return
    panelKey = key

    const title =
      mode.kind === 'pick'
        ? 'Containers'
        : `Move “${escapeHtml(displayTitle(moving?.title ?? '', moving?.url ?? ''))}” to…`
    const sharedLabel = 'No container (shared)'

    const rowHtml = (partition: string, label: string, tag: string, isCurrent: boolean): string => {
      // Picking arms the omnibox; moving re-opens the tile. A jar with no omnibox
      // spelling (a bare in-memory name) can still be moved into, so it is only
      // disabled in pick mode — the menu says what it can honestly do.
      const prefix = containerPrefix(partition)
      const disabled = mode.kind === 'pick' && prefix === null
      const title =
        disabled
          ? 'This jar cannot be reopened from the omnibox — it has no spelling'
          : mode.kind === 'pick'
            ? `Open the next tile in ${label}`
            : `Move this tile into ${label}`
      return `
        <button class="ctr-row${isCurrent ? ' current' : ''}" data-partition="${escapeHtml(partition)}" type="button"${
          disabled ? ' disabled' : ''
        } title="${escapeHtml(title)}">
          <span class="ctr-name">${escapeHtml(label)}</span>
          <span class="ctr-tag">${escapeHtml(tag)}</span>
        </button>`
    }

    const rows = choices
      .map((choice) => {
        const isCurrent =
          mode.kind === 'move'
            ? (moving?.partition ?? DEFAULT_TILE_PARTITION) === choice.partition
            : false
        const row = rowHtml(choice.partition, choice.label, choice.persistent ? 'persist' : 'memory', isCurrent)
        if (mode.kind !== 'pick') {
          return `<div class="ctr-line">${row}</div>`
        }
        const clearing = pendingClear === choice.partition
        return `
          <div class="ctr-line">
            ${row}
            <button class="ctr-clear${clearing ? ' pending' : ''}" data-clear="${escapeHtml(
              choice.partition,
            )}" type="button" title="${
              clearing ? 'Press again to erase this container' : 'Clear this container’s cookies and storage'
            }">${clearing ? 'Clear?' : '✕'}</button>
          </div>`
      })
      .join('')

    const sharedRow = rowHtml(
      DEFAULT_TILE_PARTITION,
      sharedLabel,
      'default',
      mode.kind === 'move' && (moving?.partition ?? DEFAULT_TILE_PARTITION) === DEFAULT_TILE_PARTITION,
    )
    // In pick mode the shared row sits in the same two-column line as every other
    // container (name + clear slot); in move mode there is nothing to clear.
    const sharedLine = mode.kind === 'pick' ? `<div class="ctr-line">${sharedRow}</div>` : sharedRow
    const emptyLine =
      choices.length === 0
        ? '<p class="ctr-empty">No other containers open yet</p>'
        : ''
    const confirmWord = mode.kind === 'pick' ? 'Use' : 'Move'

    ctrMenu.innerHTML = `
      <div class="ctr-head">
        <span class="ctr-title">${title}</span>
        <button class="ctr-cancel" data-role="ctr-cancel" type="button" title="Close (Esc)">✕</button>
      </div>
      ${sharedLine}
      ${rows}
      ${emptyLine}
      <div class="ctr-new">
        <input class="ctr-input" data-role="ctr-name" placeholder="new container" spellcheck="false" autocomplete="off" />
        <button class="ctr-go" data-role="ctr-new-go" type="button">${confirmWord}</button>
      </div>
    `

    const commit = (partition: string): void => {
      const target = partition
      closePanel()
      if (mode.kind === 'pick') {
        run({ kind: 'focus-omnibox', prefix: containerPrefix(target) ?? '' })
        return
      }
      dispatch({ kind: 'move-tile', id: mode.id, partition: target })
    }

    for (const button of ctrMenu.querySelectorAll<HTMLButtonElement>('[data-partition]')) {
      if (button.disabled) continue
      button.addEventListener('click', () => commit(button.dataset.partition ?? DEFAULT_TILE_PARTITION))
    }

    for (const button of ctrMenu.querySelectorAll<HTMLButtonElement>('[data-clear]')) {
      button.addEventListener('click', () => {
        const partition = button.dataset.clear ?? ''
        if (pendingClear !== partition) {
          pendingClear = partition
          panelKey = ''
          if (current) renderPanel(current)
          return
        }
        pendingClear = null
        panelKey = ''
        if (current) renderPanel(current)
        void ctx.clearContainer(partition).then((result) => {
          if (!result.ok) showError(result.error ?? 'clear failed')
          else showError(`${containerLabel(partition) ?? partition} cleared`)
        })
      })
    }

    must<HTMLButtonElement>(ctrMenu, '[data-role="ctr-cancel"]').addEventListener('click', () => closePanel())

    const input = must<HTMLInputElement>(ctrMenu, '[data-role="ctr-name"]')
    const submitNew = (): void => {
      const name = input.value.trim()
      // The same rule `session-partition.ts` enforces, checked before a name is
      // turned into a storage key: a menu that submits `../../etc` would be a menu
      // that opens the shared jar after looking like it accepted the name.
      if (!isTilePartition(`persist:${name}`)) {
        showError('a container name is letters, digits, - and _ (1–64)')
        input.focus()
        return
      }
      commit(`persist:${name}`)
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        submitNew()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        closePanel()
      }
    })
    must<HTMLButtonElement>(ctrMenu, '[data-role="ctr-new-go"]').addEventListener('click', submitNew)
  }

  // ---------------------------------------------------------- bookmark shelf

  const closeBookmarks = (): void => {
    bookmarkOpen = false
    bookmarkKey = ''
    bkMenu.hidden = true
    bkMenu.innerHTML = ''
    bookmarksBtn.classList.remove('active')
  }

  const openBookmarks = (): void => {
    // The five panels are alternatives, not layers: they share the same 280px, so a
    // second one open would push the tile list off the view.
    closeMenu()
    closePanel()
    closeLayers()
    inspector.setOpen(false)
    themeBtn.classList.remove('on')
    bookmarkOpen = true
    bookmarkKey = ''
    bookmarksBtn.classList.add('active')
    bkMenu.hidden = false
    if (current) renderBookmarks(current)
  }

  /**
   * The shelf: every bookmark, newest first, as a launch row.
   *
   * Rebuilt only when the list changes — a config push happens on every inventory and
   * status tick, and rebuilding under a pointer would drop the press that was about to
   * open a tile. The ✕ is the star's other half: one press forgets the page, and the
   * row goes away because main pushes a new list rather than because the row hid itself.
   */
  function renderBookmarks(config: OverlayConfig): void {
    if (!bookmarkOpen) return
    const records = config.bookmarks
    const key = records.map((record) => [record.id, record.title, record.url].join('\u0001')).join('\u0000')
    if (key === bookmarkKey) return
    bookmarkKey = key

    const head = `
      <div class="layer-head">
        <span class="layer-title">Bookmarks</span>
        <span class="layer-hint">${records.length} saved</span>
        <button class="ctr-cancel" data-role="bk-cancel" type="button" title="Close (Esc)">✕</button>
      </div>`

    if (records.length === 0) {
      bkMenu.innerHTML = `${head}<p class="ctr-empty">Nothing saved yet — press ☆ on a tile</p>`
      must<HTMLButtonElement>(bkMenu, '[data-role="bk-cancel"]').addEventListener('click', () => closeBookmarks())
      return
    }

    bkMenu.innerHTML =
      head +
      records
        .map(
          (record) => `
      <div class="bk-row" data-bookmark-id="${escapeHtml(record.id)}" title="${escapeHtml(record.url)}">
        <span class="row-favicon" style="--hue:${hueFor(record.url)}">${escapeHtml(faviconLetter(record.url))}</span>
        <span class="row-title">${escapeHtml(record.title)}</span>
        <span class="bk-host">${escapeHtml(hostOf(record.url) ?? '')}</span>
        <button class="row-close" data-role="remove-bookmark" type="button" title="Remove this bookmark">✕</button>
      </div>`,
        )
        .join('')

    must<HTMLButtonElement>(bkMenu, '[data-role="bk-cancel"]').addEventListener('click', () => closeBookmarks())

    for (const row of bkMenu.querySelectorAll<HTMLElement>('[data-bookmark-id]')) {
      const id = row.dataset.bookmarkId ?? ''
      if (!id) continue
      row.addEventListener('click', (event) => {
        if ((event.target as HTMLElement | null)?.closest('[data-role="remove-bookmark"]')) return
        // The tile is the point of the shelf, so the panel gets out of the way first;
        // a row that opened a tile behind its own list would read as nothing happening.
        closeBookmarks()
        run({ kind: 'open-bookmark', id })
      })
      row.querySelector('[data-role="remove-bookmark"]')?.addEventListener('click', (event) => {
        event.stopPropagation()
        dispatch({ kind: 'remove-bookmark', id })
      })
    }
  }

  // ------------------------------------------------------------ layer panel

  const closeLayers = (): void => {
    layerOpen = false
    layerKey = ''
    layerMenu.hidden = true
    layerMenu.innerHTML = ''
    layersBtn.classList.remove('active')
  }

  const openLayers = (): void => {
    closeMenu()
    closePanel()
    closeBookmarks()
    inspector.setOpen(false)
    themeBtn.classList.remove('on')
    layerOpen = true
    layerKey = ''
    layersBtn.classList.add('active')
    layerMenu.hidden = false
    if (current) renderLayers(current)
  }

  /**
   * The layer list is the paint order, front to back — which is the reverse of the
   * model, because the model is stored the way it is applied (index 0 is added
   * first, so it paints at the back). This is the only place that flips it.
   *
   * A control that cannot do anything is not rendered as enabled: the front button
   * on the topmost row and the back button on the bottom row are disabled, and no
   * row other than the front one can "raise further".
   */
  function renderLayers(config: OverlayConfig): void {
    if (!layerOpen) return
    // Sorted copy: the inventory is in creation order (a raise must not reorder the
    // row list under the pointer), so the order this panel shows is derived here.
    const rows = [...config.tiles].sort((a, b) => b.layer - a.layer)
    const key = rows
      .map((tile) => [tile.id, tile.layer, tile.selected ? 1 : 0, tile.partition ?? '', tile.title, tile.url].join('\u0001'))
      .join('\u0000')
    if (key === layerKey) return
    layerKey = key

    const head = `
      <div class="layer-head">
        <span class="layer-title">Layer order</span>
        <span class="layer-hint">front → back</span>
        <button class="ctr-cancel" data-role="layer-cancel" type="button" title="Close (Esc)">✕</button>
      </div>`

    if (rows.length === 0) {
      layerMenu.innerHTML = `${head}<p class="ctr-empty">No tiles open</p>`
    } else {
      const body = rows
        .map((tile, index) => {
          const atFront = index === 0
          const atBack = index === rows.length - 1
          return `
        <div class="layer-row${tile.selected ? ' selected' : ''}" data-layer-id="${escapeHtml(tile.id)}" title="${escapeHtml(tile.url)}">
          <span class="layer-num">${index + 1}</span>
          <span class="row-favicon" style="--hue:${hueFor(tile.url)}">${escapeHtml(faviconLetter(tile.url))}</span>
          ${badgeHtml(tile)}
          <span class="row-title">${escapeHtml(displayTitle(tile.title, tile.url))}</span>
          <button class="layer-move" data-role="layer-front" type="button" title="${
            atFront ? 'Already in front' : 'Bring to front'
          }"${atFront ? ' disabled' : ''}>▲</button>
          <button class="layer-move" data-role="layer-back" type="button" title="${
            atBack ? 'Already at the back' : 'Send to back'
          }"${atBack ? ' disabled' : ''}>▼</button>
        </div>`
        })
        .join('')
      layerMenu.innerHTML = `${head}${body}`
    }

    must<HTMLButtonElement>(layerMenu, '[data-role="layer-cancel"]').addEventListener('click', () => closeLayers())

    for (const row of layerMenu.querySelectorAll<HTMLElement>('[data-layer-id]')) {
      const id = row.dataset.layerId ?? ''
      if (!id) continue
      row.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null
        // The two controls press themselves; anything else in the row focuses.
        if (target?.closest('[data-role="layer-front"], [data-role="layer-back"]')) return
        run({ kind: 'tile-focus', id })
      })
      row.querySelector('[data-role="layer-front"]')?.addEventListener('click', (event) => {
        event.stopPropagation()
        dispatch({ kind: 'layer-order', id, to: 'front' })
      })
      row.querySelector('[data-role="layer-back"]')?.addEventListener('click', (event) => {
        event.stopPropagation()
        dispatch({ kind: 'layer-order', id, to: 'back' })
      })
    }
  }

  /**
   * Rows are rebuilt only when their content changes: a rebuild on every zoom
   * tick would drop the hover state and the close button mid-click.
   */
  function renderList(config: OverlayConfig): void {
    const tiles = config.tiles
    // Explicit fields, not `JSON.stringify(tiles)`: `layer` belongs to the layer
    // panel, and rebuilding this list on every raise would drop the hover state (and
    // the close button) under the pointer that just pressed a tile.
    const key = tiles
      .map((tile) =>
        [
          tile.id,
          tile.title,
          tile.url,
          tile.selected ? 1 : 0,
          tile.loading ? 1 : 0,
          tile.failed ? 1 : 0,
          tile.partition ?? '',
          tile.cosmetic === true ? 1 : 0,
          tile.paused === true ? 1 : 0,
        ].join('\u0001'),
      )
      .join('\u0000')
    if (key === listKey) return
    listKey = key

    if (tiles.length === 0) {
      list.innerHTML = '<li class="empty">No tiles open</li>'
      return
    }

    list.innerHTML = tiles.map((tile) => rowHtml(tile)).join('')

    for (const row of list.querySelectorAll<HTMLElement>('[data-tile-id]')) {
      row.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null
        if (target?.closest('[data-role="close-tile"], [data-role="move-tile"], [data-role="cosmetic-tile"]')) return
        const id = row.dataset.tileId ?? ''
        if (id) run({ kind: 'tile-focus', id })
      })
      row.querySelector('[data-role="close-tile"]')?.addEventListener('click', (event) => {
        event.stopPropagation()
        const id = row.dataset.tileId ?? ''
        if (id) run({ kind: 'tile-close', id })
      })
      row.querySelector('[data-role="move-tile"]')?.addEventListener('click', (event) => {
        event.stopPropagation()
        const id = row.dataset.tileId ?? ''
        if (id) {
          // The panels are alternatives, not layers: they share the same 280px.
          closeLayers()
          openPanel({ kind: 'move', id })
        }
      })
      /**
       * The pause is per host, not per tile, but the row is where a site is in front of
       * the user. Two tiles on one host therefore both flip: the row reports host state.
       */
      row.querySelector('[data-role="cosmetic-tile"]')?.addEventListener('click', (event) => {
        event.stopPropagation()
        const host = hostOf(row.dataset.tileUrl ?? '')
        if (host) run({ kind: 'toggle-cosmetic', host })
      })
    }
  }

  /**
   * The container pill, from the tile's one partition string. The tile chrome, the
   * tile row and the layer row all label it here, so a list cannot name a jar the
   * tile is not in; `undefined` (the shared jar) draws no pill at all.
   */
  function badgeHtml(tile: TileSummary): string {
    if (tile.partition === undefined) return ''
    const label = containerLabel(tile.partition)
    if (label === null) return ''
    return `<span class="row-badge${isPersistentPartition(tile.partition) ? '' : ' temp'}" title="${escapeHtml(
      tile.partition,
    )}">${escapeHtml(label)}</span>`
  }

  function rowHtml(tile: TileSummary): string {
    const title = displayTitle(tile.title, tile.url)
    const classes = ['tile-row']
    if (tile.selected) classes.push('selected')
    if (tile.loading) classes.push('loading')
    if (tile.failed) classes.push('failed')
    // The same pill the tile's own chrome draws, from the same partition string:
    // a row and a title bar cannot disagree about which jar a page is in.
    const badge = badgeHtml(tile)
    return `
      <li class="${classes.join(' ')}" data-tile-id="${escapeHtml(tile.id)}" data-tile-url="${escapeHtml(tile.url)}" title="${escapeHtml(tile.url)}">
        <span class="row-favicon" style="--hue:${hueFor(tile.url)}">${escapeHtml(faviconLetter(tile.url))}</span>
        ${badge}
        <span class="row-title">${escapeHtml(title)}</span>
        <button class="row-move" data-role="move-tile" type="button" title="Move to container">⇄</button>
        ${
          tile.cosmetic === true
            ? `<button class="row-cosmetic${tile.paused === true ? ' off' : ''}" data-role="cosmetic-tile" type="button" title="${
                tile.paused === true ? 'Cosmetic filtering paused — resume' : 'Cosmetic filtering on — pause for this site'
              }">🛡</button>`
            : ''
        }
        <button class="row-close" data-role="close-tile" type="button" title="Close tile">✕</button>
      </li>`
  }

  // ---------------------------------------------------------------- controls

  /**
   * Rename happens in the header, not in a dialog: `window.prompt` does not exist
   * in this renderer, and an inline field keeps the workspace you are editing in
   * view. Enter commits, Escape reverts, blur commits (clicking away is not a
   * cancel in any other file manager).
   */
  const startRename = (): void => {
    const config = current
    if (!config || renaming) return
    closeMenu()
    renaming = true
    const input = document.createElement('input')
    input.className = 'ws-name-input'
    input.value = config.current
    input.spellcheck = false
    wsName.replaceWith(input)
    input.focus()
    input.select()

    let settled = false
    const finish = (commit: boolean): void => {
      if (settled) return
      settled = true
      const next = input.value.trim()
      input.replaceWith(wsName)
      renaming = false
      if (commit && next !== '' && next !== config.current) {
        void ctx.act({ kind: 'rename-workspace', name: config.current, next }).then((result) => {
          if (!result.ok) showError(result.error ?? 'rename failed')
        })
      }
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
  }

  renameBtn.addEventListener('click', () => startRename())

  duplicateBtn.addEventListener('click', () => {
    const config = current
    if (!config) return
    // The menu stays open until the duplicate lands, so a refusal is readable.
    void ctx.act({ kind: 'duplicate-workspace', name: config.current }).then((result) => {
      if (result.ok) closeMenu()
      else showError(result.error ?? 'duplicate failed')
    })
  })

  // Delete is a two-step press: the menu item becomes the confirmation, so a
  // stray click on a list of workspace names cannot unlink one.
  deleteBtn.addEventListener('click', () => {
    const config = current
    if (!config) return
    if (pendingDelete !== config.current) {
      pendingDelete = config.current
      deleteBtn.textContent = `Delete "${config.current}"?`
      return
    }
    pendingDelete = null
    deleteBtn.textContent = 'Delete…'
    void ctx.act({ kind: 'delete-workspace', name: config.current }).then((result) => {
      if (result.ok) closeMenu()
      else showError(result.error ?? 'delete failed')
    })
  })

  collapse.addEventListener('click', () => {
    if (!open) {
      run({ kind: 'toggle-sidebar' })
      return
    }
    menuOpen = false
    menu.hidden = true
    closePanel()
    closeLayers()
    closeBookmarks()
    run({ kind: 'toggle-sidebar' })
  })

  picker.addEventListener('click', (event) => {
    event.stopPropagation()
    if (!current) return
    closePanel()
    closeBookmarks()
    menuOpen = !menuOpen
    menu.hidden = !menuOpen
    if (menuOpen) renderMenu(current)
  })

  containersBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    if (panel !== null) closePanel()
    else {
      closeLayers()
      openPanel({ kind: 'pick' })
    }
  })

  layersBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    if (layerOpen) closeLayers()
    else openLayers()
  })

  themeBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    if (!current) return
    // The five panels are alternatives, not layers: two open at once would fight
    // for the same 280px and the second would push the tile list off the view.
    closeMenu()
    closePanel()
    closeLayers()
    closeBookmarks()
    inspector.setOpen(!inspector.isOpen())
    themeBtn.classList.toggle('on', inspector.isOpen())
  })

  bookmarksBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    if (bookmarkOpen) closeBookmarks()
    else openBookmarks()
  })

  save.addEventListener('click', () => {
    if (!current) return
    run({ kind: 'save', name: current.current })
  })

  // Any click that is not in a panel closes it; neither panel is a modal.
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement | null
    if (menuOpen && !target?.closest('[data-role="ws-menu"], [data-role="ws-picker"]')) {
      menuOpen = false
      menu.hidden = true
    }
    if (
      panel !== null &&
      !target?.closest('[data-role="ctr-menu"], [data-role="containers"], [data-role="move-tile"]')
    ) {
      closePanel()
    }
    if (layerOpen && !target?.closest('[data-role="layer-menu"], [data-role="layers"]')) {
      closeLayers()
    }
    if (bookmarkOpen && !target?.closest('[data-role="bk-menu"], [data-role="bookmarks"]')) {
      closeBookmarks()
    }
    if (inspector.isOpen() && !target?.closest('[data-role="theme-panel"], [data-role="theme"]')) {
      inspector.setOpen(false)
      themeBtn.classList.remove('on')
    }
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (menuOpen) {
        menuOpen = false
        menu.hidden = true
        return
      }
      if (panel !== null) {
        closePanel()
        return
      }
      if (layerOpen) {
        closeLayers()
        return
      }
      if (bookmarkOpen) {
        closeBookmarks()
        return
      }
      if (inspector.isOpen()) {
        inspector.setOpen(false)
        themeBtn.classList.remove('on')
        return
      }
    }
    // This view owns the keyboard while the panel has focus, so the canvas's own
    // shortcut listener never sees these keys. Matched on `code` rather than
    // `key` so the backslash key needs no escape soup.
    if (!event.metaKey) return
    if (event.code !== 'KeyB' && event.code !== 'Backslash') return
    event.preventDefault()
    run({ kind: 'toggle-sidebar' })
  })

  // ----------------------------------------------------------------- render

  return (config: OverlayConfig, status: CanvasStatus | null): void => {
    try {
      current = config
      if (config.sidebarOpen !== open) {
        open = config.sidebarOpen
        aside.classList.toggle('collapsed', !open)
        collapse.textContent = open ? '«' : '»'
        collapse.title = open ? 'Collapse sidebar (⌘\\\\)' : 'Expand sidebar (⌘\\\\)'
        if (!open) {
          closeMenu()
          closePanel()
          closeLayers()
          closeBookmarks()
        }
      }

      // Never overwrite the field while a rename is in flight.
      if (!renaming) wsName.textContent = config.current
      renderList(config)
      if (menuOpen) renderMenu(config)
      if (panel !== null) renderPanel(config)
      if (layerOpen) renderLayers(config)
      if (bookmarkOpen) renderBookmarks(config)

      const tiles = status?.tiles ?? config.tiles.length
      count.textContent = `${tiles} tile${tiles === 1 ? '' : 's'}`
      zoomEl.textContent = `${Math.round((status?.zoom ?? config.zoom ?? 1) * 100)}%`
    } catch (failure) {
      console.error('[sidebar] render failed:', failure)
    }
  }
}
