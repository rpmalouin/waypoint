/**
 * Layer order: which tile paints in front of which.
 *
 * The order is a **back-to-front list of tile ids** — index 0 is the tile at the
 * back, the one whose `WebContentsView` was added first and whose element carries
 * the lowest z-index. Ascending index is therefore the order both layers are
 * applied in, which is why the model and the saved file use this direction and the
 * sidebar panel is the only place that flips it for display.
 *
 * `undefined` out of `normalizeLayerOrder()` is the persistence rule, not an
 * error: it means "this is the creation order", which is exactly the condition
 * that leaves the `stack` key out of the file so a workspace that never raised a
 * tile keeps the exact file shape it had before layers existed. Same convention as
 * `coerceTheme()`.
 *
 * Nothing here touches the DOM, Electron or the filesystem, so `npm test` can
 * import it directly (see `tests/layers.test.ts`, which is its specification).
 */

/** Move a tile to the front (the end of the back-to-front list). */
export function moveToEnd(order: readonly string[], id: string): string[] {
  if (!order.includes(id)) return [...order]
  return [...order.filter((entry) => entry !== id), id]
}

/** Move a tile to the back (the start of the back-to-front list). */
export function moveToStart(order: readonly string[], id: string): string[] {
  if (!order.includes(id)) return [...order]
  return [id, ...order.filter((entry) => entry !== id)]
}

/**
 * Coerce an untrusted order against the ids that actually exist.
 *
 * - unknown ids are dropped rather than repaired: a repaired id addresses nothing;
 * - duplicates are dropped, because a list with one id twice is not a total order;
 * - ids missing from the list are appended in `ids` order, so a hand-edited or
 *   older file cannot leave a live tile without a position;
 * - a result equal to `ids` returns `undefined` — the default, i.e. creation order.
 *
 * There is no separate cap: only ids present in `ids` survive, and the loader
 * already bounds that list at `MAX_TILES_PER_WORKSPACE`.
 */
export function normalizeLayerOrder(raw: unknown, ids: readonly string[]): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const known = new Set(ids)
  const order: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    if (!known.has(entry) || seen.has(entry)) continue
    seen.add(entry)
    order.push(entry)
  }
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }
  if (order.length === ids.length && order.every((id, index) => id === ids[index])) return undefined
  return order
}
