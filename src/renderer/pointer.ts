/**
 * Pointer capture is best-effort, never load-bearing.
 *
 * `setPointerCapture` throws `NotFoundError` whenever the pointer is no longer
 * active: a press and release inside one frame, an event synthesised by a test,
 * a touch that ended before the handler ran, a second press while the first is
 * still held. The gesture state is already recorded by the time we ask for
 * capture, and capture only keeps move events arriving after the pointer leaves
 * the element — a convenience. Letting it throw would silently abort whatever
 * runs after it in the same handler (a carried-tile snapshot, for instance),
 * which is exactly the kind of half-started gesture that looks like a dead
 * feature.
 */
export function capturePointer(target: Element, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId)
  } catch {
    // The drag still tracks while the pointer stays over the target.
  }
}

/** Release only what is actually captured; `releasePointerCapture` throws too. */
export function releasePointer(target: Element, pointerId: number): void {
  try {
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
  } catch {
    // Nothing to release.
  }
}
