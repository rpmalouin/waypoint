export const CH = {
  // canvas renderer → main
  tileCreate: 'tile:create',
  tileUpdateBounds: 'tile:update-bounds',
  tileDestroy: 'tile:destroy',
  tileCommand: 'tile:command',
  tileFocus: 'tile:focus',
  /**
   * The painting order of the tile views, back to front. The canvas owns the order
   * (it is the only side that knows the DOM z-order), so it proposes the whole list
   * and main re-adds the views in that sequence.
   */
  tileStack: 'tile:stack',
  /** Dark mode for one tile. Both directions are `invoke`: main answers what it applied. */
  tileDark: 'tile:dark-mode',
  /** Clip one tile's page to a markdown file. Main does the extraction and the write. */
  tileClip: 'tile:clip-to-obsidian',
  /**
   * Bookmarks. The canvas asks to toggle one URL and main answers the state it
   * reached; the list comes back over `bookmarksChanged` (and, for the chrome, in
   * `overlay:config`). There is no per-bookmark CRUD surface beyond these: the file
   * is main's, and a renderer names a URL, never a record.
   */
  bookmarkToggle: 'bookmark:toggle',
  bookmarkList: 'bookmark:list',
  tileInventory: 'tile:inventory',
  hudRequest: 'hud:request',
  hudStatus: 'hud:status',
  dockRequest: 'dock:request',
  chromeToggle: 'chrome:toggle-sidebar',
  canvasRpcReply: 'canvas:rpc-reply',
  /**
   * "Something on the canvas changed" — fire-and-forget, no payload, no answer.
   *
   * The canvas owns the world model, so it is the only side that knows a move
   * happened; main owns the file, so it is the only side that may write. This is the
   * one signal between them: main debounces it and then collects a snapshot through
   * the ordinary `collect` RPC, which keeps a single write path and lets a quit cancel
   * a pending timer instead of racing a renderer's own timer.
   */
  canvasDirty: 'canvas:dirty',
  workspaceSave: 'workspace:save',
  workspaceLoad: 'workspace:load',
  sessionGet: 'session:get',

  // main → canvas renderer
  tileRuntime: 'tile:runtime',
  tileOpenRequest: 'tile:open-request',
  canvasRpc: 'canvas:rpc',
  canvasPan: 'canvas:pan',
  /** The bookmark list, after any change, for the canvas's star. */
  bookmarksChanged: 'bookmark:changed',

  // main → chrome renderers (overlay, dock, sidebar)
  overlayConfig: 'overlay:config',
  overlayStatus: 'overlay:status',
  dockFocus: 'dock:focus',

  // chrome renderers → main
  overlayAction: 'overlay:action',
  panDelta: 'pan:delta',
  /**
   * Wipe one container's cookies and site storage. Its own fixed channel rather
   * than an `overlay:action` kind, because it is the only capability the chrome
   * has that destroys state: one named handler, one sender check, no dispatch.
   */
  containerClear: 'container:clear',

  /**
   * The theme to paint. The canvas sends it when it applies a workspace, the overlay
   * when the inspector moves a control; main coerces it once and broadcasts
   * `themeChanged` back to every view, so no renderer ever guesses another's state
   * and there is exactly one place a theme can enter the app.
   */
  themeUpdate: 'theme:update',
  themeChanged: 'theme:changed',
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]
