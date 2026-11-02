/**
 * Frame colours.
 *
 * A frame colour is a tint, not a stylesheet: the value is written into a CSS
 * custom property, so `#rrggbb` is the only shape that may ever reach it. This
 * module is the single place that decides that — the workspace loader uses it to
 * refuse a hand-edited file, the renderer uses it before writing the property, and
 * the swatch row is built from the same palette — so a colour the UI can produce
 * and a colour the loader will keep cannot drift apart.
 */

/** What a frame with no colour wears: a neutral slate that reads as "annotation". */
export const DEFAULT_FRAME_COLOR = '#7f8ea3'

/**
 * The curated palette, in swatch order.
 *
 * Six hues rather than a colour input: a frame is an annotation and its colour is
 * a label, so what matters is telling two zones apart at a glance at 2px and 40%
 * alpha over a dark canvas. All six are mid-lightness for exactly that reason —
 * a saturated primary turns into a highlighter, a dark one disappears.
 */
export const FRAME_COLORS: readonly string[] = [
  '#7f8ea3', // slate
  '#5b8fd6', // blue
  '#4f9e7f', // emerald
  '#c99a4b', // amber
  '#c76a86', // rose
  '#8b7bd0', // violet
]

/**
 * `#rrggbb` only, either case. `#abc`, `red`, `hsl(...)` and anything carrying a
 * `;` or `)` are refused: the value is interpolated into CSS, so a narrower rule
 * is the injection guard, not a style preference.
 */
const FRAME_COLOR_RE = /^#[0-9a-f]{6}$/i

export function isFrameColor(value: unknown): value is string {
  return typeof value === 'string' && FRAME_COLOR_RE.test(value)
}
