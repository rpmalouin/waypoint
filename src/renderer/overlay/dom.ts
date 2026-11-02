import type { ActionResult, OverlayAction } from '../../shared/types.ts'

export type Act = (action: OverlayAction) => void

/** Everything the chrome inserts into the DOM is built from these helpers. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

export function must<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (!found) throw new Error(`chrome markup is missing ${selector}`)
  return found
}

/**
 * A click and a double-click on the same control cannot both fire: the browser
 * emits click, click, dblclick. Anything that has a different meaning on
 * double-click routes its single-click behaviour through this so the first
 * click of a double never runs.
 */
export function splitClick(
  element: HTMLElement,
  onClick: () => void,
  onDoubleClick: () => void,
  delay = 220,
): void {
  let timer = 0
  element.addEventListener('click', () => {
    if (timer !== 0) {
      window.clearTimeout(timer)
      timer = 0
      onDoubleClick()
      return
    }
    timer = window.setTimeout(() => {
      timer = 0
      onClick()
    }, delay)
  })
}

export function reportFailure(result: ActionResult, setError: (message: string) => void): void {
  if (result.ok) {
    setError('')
    return
  }
  setError(result.error ?? 'action failed')
}
