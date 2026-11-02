import assert from 'node:assert/strict'
import test from 'node:test'
import { HARMONY_MODES, generatePalette, isHexColor } from '../src/shared/color.ts'
import {
  DEFAULT_THEME,
  MAX_THEME_COLORS,
  MIN_THEME_COLORS,
  coerceTheme,
  isDefaultTheme,
  resolveTheme,
  themesEqual,
} from '../src/shared/theme.ts'

test('the default theme is itself a valid theme', () => {
  assert.ok(DEFAULT_THEME.colors.length >= MIN_THEME_COLORS)
  assert.ok(DEFAULT_THEME.colors.length <= MAX_THEME_COLORS)
  for (const color of DEFAULT_THEME.colors) assert.equal(isHexColor(color), true, color)
  assert.ok(['day', 'night'].includes(DEFAULT_THEME.mode))
  assert.ok(HARMONY_MODES.includes(DEFAULT_THEME.harmony))
  for (const value of [DEFAULT_THEME.baseHue, DEFAULT_THEME.angle]) {
    assert.ok(value >= 0 && value <= 360, `${value} outside 0-360`)
  }
  for (const value of [DEFAULT_THEME.vivid, DEFAULT_THEME.grain]) {
    assert.ok(value >= 0 && value <= 100, `${value} outside 0-100`)
  }
})

test('anything that resolves to the default coerces to undefined', () => {
  // The point of the signature: undefined is what keeps `theme` out of the file, so
  // every shape of "this is the default" has to arrive that way.
  for (const value of [null, undefined, 7, 'night', true, [], DEFAULT_THEME]) {
    assert.equal(coerceTheme(value), undefined, JSON.stringify(value))
  }
  // A theme spelled out field by field is still the default.
  assert.equal(
    coerceTheme({
      mode: 'night',
      harmony: 'analogous',
      baseHue: 220,
      vivid: 30,
      grain: 0,
      colors: ['#121620', '#1a202c', '#141824'],
      angle: 135,
    }),
    undefined,
  )
})

test('resolveTheme is the painting side: always a theme, never the default object', () => {
  const theme = resolveTheme(undefined)
  assert.deepEqual(theme, DEFAULT_THEME)
  assert.notEqual(theme, DEFAULT_THEME)
  assert.notEqual(theme.colors, DEFAULT_THEME.colors)
  // Mutating what a caller was handed cannot rewrite the default for the process.
  theme.colors.push('#ffffff')
  theme.baseHue = 1
  assert.deepEqual(DEFAULT_THEME.colors, ['#121620', '#1a202c', '#141824'])
  assert.equal(DEFAULT_THEME.baseHue, 220)
})

test('numbers are clamped into range and rounded to the integer the schema stores', () => {
  const theme = resolveTheme({ baseHue: 400, vivid: 150, grain: -5, angle: 720 })
  assert.equal(theme.baseHue, 360)
  assert.equal(theme.vivid, 100)
  assert.equal(theme.grain, 0)
  assert.equal(theme.angle, 360)

  const rounded = resolveTheme({ baseHue: 219.6, vivid: 44.4, angle: 134.5 })
  assert.equal(rounded.baseHue, 220)
  assert.equal(rounded.vivid, 44)
  assert.equal(rounded.angle, 135)

  const negative = resolveTheme({ baseHue: -20, angle: -1 })
  assert.equal(negative.baseHue, 0)
  assert.equal(negative.angle, 0)
})

test('a field that is not a number falls back to the default, not to zero', () => {
  // Text that looks numeric is still not a number: parsing it would hand a string to
  // arithmetic and produce NaN somewhere far from the file that caused it.
  for (const value of ['220', 'lots', Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
    const theme = resolveTheme({ baseHue: value, vivid: value, grain: value, angle: value })
    assert.equal(theme.baseHue, DEFAULT_THEME.baseHue, String(value))
    assert.equal(theme.vivid, DEFAULT_THEME.vivid)
    assert.equal(theme.grain, DEFAULT_THEME.grain)
    assert.equal(theme.angle, DEFAULT_THEME.angle)
  }
})

test('unknown mode and harmony tokens fall back to the specified defaults', () => {
  assert.equal(coerceTheme({ mode: 'auto', baseHue: 10 })?.mode, 'night')
  assert.equal(coerceTheme({ mode: 'DAY', baseHue: 10 })?.mode, 'night')
  assert.equal(coerceTheme({ mode: 'day', baseHue: 10 })?.mode, 'day')
  // `free` is the documented fallback: nothing is derived for a mode the app cannot
  // name, so it must not be quietly read as one of the generated harmonies.
  assert.equal(coerceTheme({ harmony: 'octave', baseHue: 10 })?.harmony, 'free')
  assert.equal(coerceTheme({ harmony: 'triad', baseHue: 10 })?.harmony, 'triad')
  for (const harmony of HARMONY_MODES) {
    if (harmony === 'free') continue
    assert.equal(coerceTheme({ harmony, baseHue: 10 })?.harmony, harmony)
  }
})

test('unknown properties are dropped, not carried through', () => {
  const theme = coerceTheme({ baseHue: 10, evil: 'yes', colors: ['#111111', '#222222'] })
  assert.ok(theme)
  assert.deepEqual(Object.keys(theme).sort(), [
    'angle',
    'baseHue',
    'colors',
    'grain',
    'harmony',
    'mode',
    'vivid',
  ])
})

test('colours are validated, lowercased, deduped and capped', () => {
  assert.deepEqual(coerceTheme({ baseHue: 10, colors: ['#ABCDEF', '#123456'] })?.colors, [
    '#abcdef',
    '#123456',
  ])
  // Invalid entries are dropped, not escaped or repaired.
  assert.deepEqual(
    coerceTheme({ baseHue: 10, colors: ['#111111', 'red', '#222222', 'rgb(1,2,3)', '#333333'] })?.colors,
    ['#111111', '#222222', '#333333'],
  )
  // The same colour twice is one stop, whatever its case.
  assert.deepEqual(coerceTheme({ baseHue: 10, colors: ['#aabbcc', '#AABBCC', '#111111'] })?.colors, [
    '#aabbcc',
    '#111111',
  ])
  assert.equal(
    coerceTheme({ baseHue: 10, colors: ['#111111', '#222222', '#333333', '#444444', '#555555'] })?.colors
      .length,
    MAX_THEME_COLORS,
  )
})

test('a depleted palette is regenerated from the harmony', () => {
  // One usable stop is not a gradient, and the harmony can supply what the file lost
  // — so it does, instead of substituting a palette nobody chose.
  const theme = coerceTheme({ harmony: 'triad', mode: 'day', baseHue: 30, vivid: 40, colors: ['#111111'] })
  assert.deepEqual(theme?.colors, generatePalette('triad', 30, 40, 'day'))
  assert.equal(theme?.colors.length, 3)

  // Two entries that survive intact are kept exactly as written.
  const kept = coerceTheme({ harmony: 'triad', baseHue: 30, vivid: 40, colors: ['#111111', '#222222'] })
  assert.deepEqual(kept?.colors, ['#111111', '#222222'])
})

test('free mode cannot regenerate, so a depleted free palette falls back to the default', () => {
  // generatePalette('free') is [] by design — the mode derives no relationship, so
  // there is nothing to regenerate from and the default palette is the honest answer.
  assert.deepEqual(generatePalette('free', 30, 40, 'night'), [])
  const theme = coerceTheme({ harmony: 'free', baseHue: 30, colors: ['#111111'] })
  assert.deepEqual(theme?.colors, DEFAULT_THEME.colors)
  // Still stored: baseHue 30 is not the default, so this theme is not the default.
  assert.ok(theme)
})

test('a complete, valid theme survives unchanged', () => {
  const given = {
    mode: 'day',
    harmony: 'split',
    baseHue: 137,
    vivid: 62,
    grain: 45,
    colors: ['#f7e6c4', '#f2c9a0', '#e8b9b0'],
    angle: 240,
  }
  assert.deepEqual(coerceTheme(given), given)
  assert.equal(isDefaultTheme(resolveTheme(given)), false)
})

test('themesEqual compares every field and the colour list in order', () => {
  const base = resolveTheme(undefined)
  assert.equal(themesEqual(base, resolveTheme(undefined)), true)
  assert.equal(themesEqual(base, { ...base, grain: 1 }), false)
  assert.equal(themesEqual(base, { ...base, mode: 'day' }), false)
  // Same colours, different order is a different gradient.
  assert.equal(
    themesEqual({ ...base, colors: ['#000000', '#111111'] }, { ...base, colors: ['#111111', '#000000'] }),
    false,
  )
  assert.equal(isDefaultTheme(base), true)
  assert.equal(isDefaultTheme({ ...base, angle: 0 }), false)
})
