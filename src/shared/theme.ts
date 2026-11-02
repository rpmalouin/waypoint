/**
 * Workspace themes: the schema, the default, and the two functions the rest of the
 * app is allowed to use.
 *
 * A theme is untrusted input twice — a hand-edited workspace file, and whatever the
 * overlay last sent — so `coerceTheme()` builds a fresh object from named fields
 * only, drops anything it does not recognise, and answers `undefined` for "this is
 * the default", which is what keeps `theme` out of the saved file. `resolveTheme()`
 * is the painting side of the same rule: it always returns a usable theme.
 */

import { HARMONY_MODES, generatePalette, isHexColor } from './color.ts'
import type { HarmonyMode, PaletteMode } from './color.ts'

export interface WorkspaceTheme {
  /** Which palette band the colours were generated in. */
  mode: PaletteMode
  /** How `colors` was derived. `free` means the colours are the user's own. */
  harmony: HarmonyMode
  /** Base hue in integer degrees, 0-360. */
  baseHue: number
  /** Saturation drive, integer percent 0-100. */
  vivid: number
  /** Grain overlay strength, integer percent 0-100. 0 means no grain at all. */
  grain: number
  /** The materialised palette, 2-4 `#rrggbb` strings. This is what gets painted. */
  colors: string[]
  /** Gradient direction in integer degrees, 0-360. */
  angle: number
}

/**
 * A dark, low-saturation default: a workspace that has never been themed should look
 * like the canvas it has always been, not like a light theme nobody chose.
 */
export const DEFAULT_THEME: WorkspaceTheme = {
  mode: 'night',
  harmony: 'analogous',
  baseHue: 220,
  vivid: 30,
  grain: 0,
  colors: ['#121620', '#1a202c', '#141824'],
  angle: 135,
}

/** A gradient needs two ends; more than four stops is noise at canvas scale. */
export const MIN_THEME_COLORS = 2
export const MAX_THEME_COLORS = 4

const MODES: readonly PaletteMode[] = ['day', 'night']

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asIntegerIn(value: unknown, min: number, max: number, fallback: number): number {
  // Text that looks numeric is not a number: coercing it would put a string into a
  // field the renderer does arithmetic on.
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  // Clamped, then rounded: the schema stores integer degrees, so 219.6 means 220.
  return Math.min(max, Math.max(min, Math.round(value)))
}

function asMode(value: unknown): PaletteMode {
  return MODES.find((mode) => mode === value) ?? 'night'
}

function asHarmony(value: unknown): HarmonyMode {
  return HARMONY_MODES.find((mode) => mode === value) ?? 'free'
}

/**
 * The palette as a theme may carry it: valid `#rrggbb` only, lowercased so two
 * spellings cannot produce two stops that paint the same colour, deduped in place,
 * capped at four.
 *
 * A depleted list is regenerated from the harmony rather than padded with a guess.
 * `free` is the one mode that cannot regenerate — it derives no relationship by
 * definition — so it falls back to the default palette, which is the only honest
 * answer left once the user's own colours are gone.
 */
function coerceColors(
  value: unknown,
  harmony: HarmonyMode,
  baseHue: number,
  vivid: number,
  mode: PaletteMode,
): string[] {
  const colors: string[] = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isHexColor(entry)) continue
      const color = entry.toLowerCase()
      if (colors.includes(color)) continue
      colors.push(color)
      if (colors.length === MAX_THEME_COLORS) break
    }
  }
  if (colors.length >= MIN_THEME_COLORS) return colors
  const generated = generatePalette(harmony, baseHue, vivid, mode)
  if (generated.length >= MIN_THEME_COLORS) return generated
  return [...DEFAULT_THEME.colors]
}

/**
 * Raw value in, theme or `undefined` out.
 *
 * `undefined` is the point of the signature: it means "the default", and the caller
 * that persists a workspace uses that to leave the `theme` key out entirely. A value
 * that resolves to the default after coercion — a half-filled object, a stale `auto`
 * mode — is `undefined` too, because it would paint exactly the default.
 */
export function coerceTheme(raw: unknown): WorkspaceTheme | undefined {
  const record = asObject(raw)
  if (!record) return undefined

  const mode = asMode(record.mode)
  const harmony = asHarmony(record.harmony)
  const baseHue = asIntegerIn(record.baseHue, 0, 360, DEFAULT_THEME.baseHue)
  const vivid = asIntegerIn(record.vivid, 0, 100, DEFAULT_THEME.vivid)
  const grain = asIntegerIn(record.grain, 0, 100, DEFAULT_THEME.grain)
  const angle = asIntegerIn(record.angle, 0, 360, DEFAULT_THEME.angle)
  const colors = coerceColors(record.colors, harmony, baseHue, vivid, mode)

  const theme: WorkspaceTheme = { mode, harmony, baseHue, vivid, grain, colors, angle }
  return isDefaultTheme(theme) ? undefined : theme
}

/**
 * The painting side: always a theme, never `undefined`, and never `DEFAULT_THEME`
 * itself — a caller that mutates what it was handed must not rewrite the default for
 * the rest of the process.
 */
export function resolveTheme(raw: unknown): WorkspaceTheme {
  return coerceTheme(raw) ?? { ...DEFAULT_THEME, colors: [...DEFAULT_THEME.colors] }
}

export function themesEqual(a: WorkspaceTheme, b: WorkspaceTheme): boolean {
  return (
    a.mode === b.mode &&
    a.harmony === b.harmony &&
    a.baseHue === b.baseHue &&
    a.vivid === b.vivid &&
    a.grain === b.grain &&
    a.angle === b.angle &&
    a.colors.length === b.colors.length &&
    a.colors.every((color, index) => color === b.colors[index])
  )
}

export function isDefaultTheme(theme: WorkspaceTheme): boolean {
  return themesEqual(theme, DEFAULT_THEME)
}
