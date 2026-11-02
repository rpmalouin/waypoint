import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { CH } from '../shared/channels.ts'
import type { CanvasBridge } from '../shared/bridge.ts'
import type { WorkspaceTheme } from '../shared/theme.ts'
import type { BookmarkRecord } from '../shared/bookmarks.ts'
import type { TileRecord, TileRuntime } from '../shared/types.ts'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

// Every entry is a named method with a fixed shape. ipcRenderer itself never
// crosses the bridge, and no method accepts a channel name from the renderer.
const bridge: CanvasBridge = {
  platform: process.platform,

  createTile: (request) => ipcRenderer.send(CH.tileCreate, request),
  updateBounds: (updates) => ipcRenderer.send(CH.tileUpdateBounds, updates),
  destroyTile: (id) => ipcRenderer.send(CH.tileDestroy, { id }),
  command: (id, command) => ipcRenderer.send(CH.tileCommand, { id, command }),
  focusTile: (id) => ipcRenderer.send(CH.tileFocus, { id }),
  stackTiles: (ids) => ipcRenderer.send(CH.tileStack, ids),
  setTileDark: (id, on) => ipcRenderer.invoke(CH.tileDark, { id, on }),
  clipTile: (id) => ipcRenderer.invoke(CH.tileClip, { id }),
  toggleBookmark: (entry) => ipcRenderer.invoke(CH.bookmarkToggle, entry),
  listBookmarks: () => ipcRenderer.invoke(CH.bookmarkList),

  saveWorkspace: (name, snapshot) => ipcRenderer.invoke(CH.workspaceSave, { name, state: snapshot }),
  loadWorkspace: (name) => ipcRenderer.invoke(CH.workspaceLoad, { name }),
  readSession: () => ipcRenderer.invoke(CH.sessionGet),
  markDirty: () => ipcRenderer.send(CH.canvasDirty),

  requestOverlay: (mode, world) => ipcRenderer.send(CH.hudRequest, { mode, world }),
  requestDockFocus: () => ipcRenderer.send(CH.dockRequest),
  toggleSidebar: () => ipcRenderer.send(CH.chromeToggle),
  pushStatus: (status) => ipcRenderer.send(CH.hudStatus, status),
  pushInventory: (tiles) => ipcRenderer.send(CH.tileInventory, tiles),
  replyRpc: (id, value) => ipcRenderer.send(CH.canvasRpcReply, { id, value }),

  onRuntime: (callback) => subscribe<TileRuntime>(CH.tileRuntime, callback),
  onOpenRequest: (callback) =>
    subscribe<{ url: string; partition?: string }>(CH.tileOpenRequest, (payload) =>
      callback(payload.url, payload.partition),
    ),
  onRpc: (callback) => subscribe(CH.canvasRpc, callback),
  onBookmarks: (callback) => subscribe<BookmarkRecord[]>(CH.bookmarksChanged, callback),
  // Pan deltas are dispatched by main, never by the canvas: only main knows
  // whether the interceptor is armed.
  onPan: (callback) => subscribe<{ dx: number; dy: number }>(CH.canvasPan, callback),
  updateTheme: (theme) => ipcRenderer.send(CH.themeUpdate, theme),
  onTheme: (callback) => subscribe<WorkspaceTheme>(CH.themeChanged, callback),
}

contextBridge.exposeInMainWorld('canvasBridge', bridge satisfies CanvasBridge)

// Keep the type checker honest about the record shape used above.
export type { TileRecord }
