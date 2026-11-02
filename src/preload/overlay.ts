import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { CH } from '../shared/channels.ts'
import type { OverlayBridge } from '../shared/bridge.ts'
import type { WorkspaceTheme } from '../shared/theme.ts'
import type { CanvasStatus, ChromeRegion, OverlayConfig } from '../shared/types.ts'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

/**
 * One page, one preload, three views: main loads overlay.html with `#dock` or
 * `#sidebar` for the floating regions and `#main` for the HUD, the modals and
 * the pan interceptor. The hash decides what this instance renders.
 */
function regionFromHash(): ChromeRegion {
  const hash = window.location.hash.replace(/^#/, '')
  return hash === 'dock' || hash === 'sidebar' ? hash : 'main'
}

const bridge: OverlayBridge = {
  platform: process.platform,
  region: regionFromHash(),
  action: (action) => ipcRenderer.invoke(CH.overlayAction, action),
  clearContainer: (partition) => ipcRenderer.invoke(CH.containerClear, { partition }),
  // Fire-and-forget: a drag emits a delta per frame and must not await a reply.
  sendPanDelta: (dx, dy) => ipcRenderer.send(CH.panDelta, { dx, dy }),
  onConfig: (callback) => subscribe<OverlayConfig>(CH.overlayConfig, callback),
  onStatus: (callback) => subscribe<CanvasStatus>(CH.overlayStatus, callback),
  onDockFocus: (callback) =>
    subscribe<{ seq: number; prefix?: string }>(CH.dockFocus, (payload) => callback(payload?.prefix)),
  updateTheme: (theme) => ipcRenderer.send(CH.themeUpdate, theme),
  onTheme: (callback) => subscribe<WorkspaceTheme>(CH.themeChanged, callback),
}

contextBridge.exposeInMainWorld('overlayBridge', bridge satisfies OverlayBridge)
