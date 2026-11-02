import type { CanvasBridge, OverlayBridge } from '../shared/bridge.ts'

declare global {
  interface Window {
    canvasBridge: CanvasBridge
    overlayBridge: OverlayBridge
  }
}

export {}
