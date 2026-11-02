/**
 * Pan-interceptor state machine.
 *
 * The interceptor is the only piece of chrome allowed to cover the whole
 * window, because its job is to swallow every pointer event. Exactly one thing
 * arms it: the dock's hand tool. Nothing here reads a key — `Space` is a
 * character, and a page owns its own keyboard, so a canvas that dimmed itself
 * because somebody pressed a spacebar was reacting to typing it never saw.
 *
 * A modal still wins over the tool, because a modal needs the clicks the
 * interceptor would take. A text field does not appear here: the dock and the
 * sidebar sit above the interceptor in the view stack, so their fields stay
 * clickable and focusable while the hand is latched, and a focus-driven disarm
 * only bought a restack that dropped the very focus that caused it.
 *
 * This module is pure so the rules can be tested without Electron. Main holds
 * the state and applies `armed` to the overlay view; the overlay only renders.
 */

export interface PanModeState {
  /** The dock's hand tool is latched on, which arms the interceptor permanently. */
  toolPan: boolean
  /** A modal owns the screen; panning would fight it. */
  modalOpen: boolean
  /** Derived: the interceptor should capture pointer events. */
  armed: boolean
}

export type PanModeEvent = { type: 'tool'; pan: boolean } | { type: 'modal'; open: boolean }

export function initialPanMode(): PanModeState {
  return { toolPan: false, modalOpen: false, armed: false }
}

function derive(state: PanModeState): PanModeState {
  const armed = state.toolPan && !state.modalOpen
  return state.armed === armed ? state : { ...state, armed }
}

/** Applies one event. Anything unknown is ignored, so a stale sender cannot arm panning. */
export function reducePanMode(state: PanModeState, event: PanModeEvent): PanModeState {
  switch (event.type) {
    case 'tool':
      if (state.toolPan === event.pan) return state
      return derive({ ...state, toolPan: event.pan })
    case 'modal':
      if (state.modalOpen === event.open) return state
      return derive({ ...state, modalOpen: event.open })
    default:
      return state
  }
}
