/**
 * Colour for workspace themes.
 *
 * Everything here is arithmetic on numbers and `#rrggbb` strings: no dependency,
 * no DOM, no state. That is deliberate — a palette is a pure function of a base
 * hue, so the unit tests can pin the maths instead of eyeballing swatches, and the
 * renderer, the workspace loader and the tests all agree because they call the
 * same code.
 */

/** How stop hues are derived from the base hue. `free` derives none. */
export type HarmonyMode = 'free' | 'complement' | 'analogous' | 'triad' | 'split'

/** The two palettes a theme can ask for. `auto` is resolved by the caller. */
export type PaletteMode = 'day' | 'night'

/** Swatch/menu order for any UI that lists the modes. */
export const HARMONY_MODES: readonly HarmonyMode[] = ['free', 'complement', 'analogous', 'triad', 'split']

/**
 * Day palettes live high and light, night palettes low and dim. The bands are the
 * spec's, kept as band *ends* rather than single values so a three-stop harmony has
 * something to vary across — three identical lightnesses make a gradient one colour.
 */
const DAY_LIGHTNESS: readonly [number, number] = [85, 70]
const NIGHT_LIGHTNESS: readonly [number, number] = [22, 10]

/**
 * `vivid` scales saturation between these ends. Day starts visible but never
 * shouting; night is subdued at both ends, because a saturated 12%-lightness colour
 * reads as a neon smear behind a canvas full of pages.
 */
const DAY_SATURATION: readonly [number, number] = [18, 82]
const NIGHT_SATURATION: readonly [number, number] = [8, 46]

const HEX_RE = /^#[0-9a-f]{6}$/i

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Fold any hue — negative, over 360, fractional — into `[0, 360)`. */
export function normalizeHue(hue: number): number {
  if (!Number.isFinite(hue)) return 0
  return ((hue % 360) + 360) % 360
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value)
}

function channelToHex(channel: number): string {
  const clamped = clamp(channel, 0, 255)
  return Math.round(clamped).toString(16).padStart(2, '0')
}

/**
 * HSL -> `#rrggbb`. `h` is folded into range, `s` and `l` are clamped to 0-100, so
 * a generator that overshoots a band produces a colour rather than `#NaN`.
 */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = normalizeHue(h)
  const saturation = clamp(s, 0, 100) / 100
  const lightness = clamp(l, 0, 100) / 100

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const match = lightness - chroma / 2

  let rgb: readonly [number, number, number]
  if (hue < 60) rgb = [chroma, second, 0]
  else if (hue < 120) rgb = [second, chroma, 0]
  else if (hue < 180) rgb = [0, chroma, second]
  else if (hue < 240) rgb = [0, second, chroma]
  else if (hue < 300) rgb = [second, 0, chroma]
  else rgb = [chroma, 0, second]

  const [r, g, b] = rgb
  return `#${channelToHex((r + match) * 255)}${channelToHex((g + match) * 255)}${channelToHex((b + match) * 255)}`
}

/**
 * `#rrggbb` -> HSL, `h` in `[0, 360)`, `s` and `l` in 0-100.
 *
 * Throws on anything that is not a hex colour. A caller holding unvalidated text
 * must ask `isHexColor()` first: returning black-ish numbers for garbage would be
 * indistinguishable from a real colour, which is the failure that survives review.
 */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  if (!isHexColor(hex)) throw new Error(`not a hex colour: ${String(hex)}`)
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const lightness = (max + min) / 2

  // A grey has no hue, and returning 0 here is honest: it is not that the hue is
  // lost, it is that no hue describes this colour. Saturations of 0 pair with it.
  if (delta === 0) return { h: 0, s: 0, l: lightness * 100 }

  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  let hue: number
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4

  return { h: normalizeHue(hue * 60), s: saturation * 100, l: lightness * 100 }
}

/**
 * The stop hues a harmony derives from `baseHue`, in rotation order.
 *
 * `free` is the documented empty case: the mode means "these are my own 2-4
 * colours, unrelated by construction", so there is no relationship to derive and
 * nothing is invented for it.
 */
export function harmonyStops(harmony: HarmonyMode, baseHue: number): number[] {
  const hue = normalizeHue(baseHue)
  switch (harmony) {
    case 'complement':
      return [hue, normalizeHue(hue + 180)]
    case 'analogous':
      return [normalizeHue(hue - 30), hue, normalizeHue(hue + 30)]
    case 'triad':
      return [hue, normalizeHue(hue + 120), normalizeHue(hue + 240)]
    case 'split':
      return [hue, normalizeHue(hue + 150), normalizeHue(hue + 210)]
    case 'free':
    default:
      return []
  }
}

/**
 * A harmony's palette as hex, ready for a gradient or a swatch row.
 *
 * Stops walk the mode's lightness band from its light end to its dim end, so three
 * analogous stops read as a gradient rather than three swatches of one colour. A
 * single stop sits at the light end. `free` returns `[]` — see `harmonyStops()`.
 */
export function generatePalette(
  harmony: HarmonyMode,
  baseHue: number,
  vivid: number,
  mode: PaletteMode,
): string[] {
  const stops = harmonyStops(harmony, baseHue)
  if (stops.length === 0) return []

  const amount = clamp(vivid, 0, 100) / 100
  const day = mode === 'day'
  const [lightFrom, lightTo] = day ? DAY_LIGHTNESS : NIGHT_LIGHTNESS
  const [satFrom, satTo] = day ? DAY_SATURATION : NIGHT_SATURATION
  const saturation = satFrom + (satTo - satFrom) * amount

  return stops.map((hue, index) => {
    const position = stops.length === 1 ? 0 : index / (stops.length - 1)
    const lightness = lightFrom + (lightTo - lightFrom) * position
    return hslToHex(hue, saturation, lightness)
  })
}

/**
 * An evenly spaced multi-stop `linear-gradient(...)`, for `--canvas-gradient` and
 * anything else that paints the theme.
 *
 * Colours that are not `#rrggbb` are dropped, and an empty result is `none` rather
 * than a gradient of nothing: this string is written into a CSS property, so
 * nothing that is not a hex colour may pass through it. The angle is folded into
 * `[0, 360)` but not rounded — CSS takes fractions, and a caller that asked for
 * 22.5 meant it.
 */
export function buildCssGradient(colors: readonly string[], angleDeg: number): string {
  const stops = colors.filter(isHexColor).map((color) => color.toLowerCase())
  if (stops.length === 0) return 'none'
  const angle = normalizeHue(angleDeg)
  if (stops.length === 1) return `linear-gradient(${angle}deg, ${stops[0]} 0%, ${stops[0]} 100%)`
  const parts = stops.map(
    (color, index) => `${color} ${Math.round((index / (stops.length - 1)) * 100)}%`,
  )
  return `linear-gradient(${angle}deg, ${parts.join(', ')})`
}
