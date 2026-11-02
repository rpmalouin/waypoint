import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HARMONY_MODES,
  buildCssGradient,
  generatePalette,
  harmonyStops,
  hexToHsl,
  hslToHex,
  isHexColor,
  normalizeHue,
} from '../src/shared/color.ts'

test('hslToHex hits the primaries and the greys', () => {
  assert.equal(hslToHex(0, 100, 50), '#ff0000')
  assert.equal(hslToHex(120, 100, 50), '#00ff00')
  assert.equal(hslToHex(240, 100, 50), '#0000ff')
  assert.equal(hslToHex(0, 0, 0), '#000000')
  assert.equal(hslToHex(0, 0, 100), '#ffffff')
  // A hue with no saturation is a grey whatever the hue says.
  assert.equal(hslToHex(47, 0, 50), '#808080')
})

test('hslToHex folds the hue and clamps what it cannot use', () => {
  assert.equal(hslToHex(360, 100, 50), hslToHex(0, 100, 50))
  assert.equal(hslToHex(-120, 100, 50), hslToHex(240, 100, 50))
  assert.equal(hslToHex(720 + 120, 100, 50), hslToHex(120, 100, 50))
  assert.equal(hslToHex(0, 500, 50), hslToHex(0, 100, 50))
  assert.equal(hslToHex(0, 100, -20), '#000000')
  assert.equal(hslToHex(Number.NaN, 100, 50), hslToHex(0, 100, 50))
})

test('hexToHsl recovers what hslToHex wrote', () => {
  const samples: [number, number, number][] = [
    [0, 100, 50],
    [212, 62, 78],
    [18, 44, 21],
    [351, 12, 84],
    [89, 95, 11],
  ]
  for (const [h, s, l] of samples) {
    const hex = hslToHex(h, s, l)
    const back = hexToHsl(hex)
    // The invariant that matters: the colour survives. Six hex digits are the
    // storage, so a round trip that lands on the same hex has lost nothing.
    assert.equal(hslToHex(back.h, back.s, back.l), hex, `round trip of ${hex}`)
    assert.ok(Math.abs(back.l - l) <= 1.5, `light ${l} -> ${back.l}`)
    assert.ok(Math.abs(back.s - s) <= 1.5, `sat ${s} -> ${back.s}`)
    // Hue is only resolvable as far as the colour has chroma to carry it: at 12%
    // saturation the 8-bit grid is several degrees wide, so demanding a degree
    // there would be asking the format for precision it cannot represent.
    const delta = Math.min(Math.abs(back.h - h), 360 - Math.abs(back.h - h))
    const tolerance = Math.max(1.5, 60 / Math.max(1, back.s))
    assert.ok(delta <= tolerance, `hue ${h} -> ${back.h} (tolerance ${tolerance.toFixed(1)})`)
  }
})

test('hexToHsl reads the greys as hue-less, and refuses what is not a hex colour', () => {
  assert.deepEqual(hexToHsl('#000000'), { h: 0, s: 0, l: 0 })
  assert.deepEqual(hexToHsl('#ffffff'), { h: 0, s: 0, l: 100 })
  const mid = hexToHsl('#808080')
  assert.equal(mid.s, 0)
  assert.ok(Math.abs(mid.l - 50.2) < 0.3)
  assert.equal(hexToHsl('#FF0000').h, 0)
  for (const bad of ['', '#fff', 'red', 'rgb(1,2,3)', '#gggggg', ' #7f8ea3', '#7f8ea3f']) {
    assert.throws(() => hexToHsl(bad), /not a hex colour/)
  }
})

test('isHexColor accepts six hex digits in either case and nothing else', () => {
  for (const good of ['#7f8ea3', '#FFFFFF', '#000000', '#AbCdEf']) assert.equal(isHexColor(good), true)
  for (const bad of ['', '#abc', 'red', 'rgb(1,2,3)', '#7f8ea', '#7f8ea3f', ' #7f8ea3', '#7f8ea3;']) {
    assert.equal(isHexColor(bad), false)
  }
  assert.equal(isHexColor(null), false)
  assert.equal(isHexColor(7), false)
})

test('normalizeHue folds anything into one turn', () => {
  assert.equal(normalizeHue(0), 0)
  assert.equal(normalizeHue(360), 0)
  assert.equal(normalizeHue(-30), 330)
  assert.equal(normalizeHue(725), 5)
  assert.equal(normalizeHue(Number.POSITIVE_INFINITY), 0)
})

test('each harmony derives the hue offsets the spec names', () => {
  assert.deepEqual(harmonyStops('complement', 20), [20, 200])
  assert.deepEqual(harmonyStops('analogous', 20), [350, 20, 50])
  assert.deepEqual(harmonyStops('triad', 20), [20, 140, 260])
  assert.deepEqual(harmonyStops('split', 20), [20, 170, 230])
  // Wrapping is folded, never emitted as 380.
  assert.deepEqual(harmonyStops('complement', 350), [350, 170])
  assert.deepEqual(harmonyStops('triad', 300), [300, 60, 180])
  // `free` derives nothing: the caller's own colours are the palette.
  assert.deepEqual(harmonyStops('free', 20), [])
})

test('generatePalette stays inside the day band and lights its stops from the top', () => {
  const day = generatePalette('triad', 210, 55, 'day')
  assert.equal(day.length, 3)
  const lightnesses = day.map((color) => hexToHsl(color).l)
  for (const l of lightnesses) {
    assert.ok(l >= 69 && l <= 86, `day lightness ${l} outside 70-85`)
  }
  // Strictly descending, so a three-stop gradient is a gradient.
  assert.ok(lightnesses[0]! > lightnesses[1]!, `${lightnesses.join(' > ')}`)
  assert.ok(lightnesses[1]! > lightnesses[2]!, `${lightnesses.join(' > ')}`)
})

test('generatePalette stays inside the night band', () => {
  const night = generatePalette('split', 210, 55, 'night')
  assert.equal(night.length, 3)
  for (const color of night) {
    const l = hexToHsl(color).l
    assert.ok(l >= 9 && l <= 23, `night lightness ${l} outside 10-22`)
  }
})

test('vivid is the only thing that moves saturation, and it moves it monotonically', () => {
  const flat = generatePalette('complement', 100, 0, 'day')
  const loud = generatePalette('complement', 100, 100, 'day')
  assert.ok(hexToHsl(flat[0]!).s < hexToHsl(loud[0]!).s, 'vivid 0 must be flatter than vivid 100')
  // Night is subdued at both ends of vivid, never as loud as day.
  const nightLoud = generatePalette('complement', 100, 100, 'night')
  assert.ok(hexToHsl(nightLoud[0]!).s < hexToHsl(loud[0]!).s, 'night must stay under day at vivid 100')
  // Out-of-range vivid is clamped, not interpolated past the band.
  assert.deepEqual(generatePalette('complement', 100, 400, 'day'), loud)
  assert.deepEqual(generatePalette('complement', 100, -50, 'day'), flat)
})

test('generatePalette returns nothing to derive for free, and every mode gives valid hex', () => {
  assert.deepEqual(generatePalette('free', 210, 50, 'day'), [])
  for (const harmony of HARMONY_MODES) {
    if (harmony === 'free') continue
    for (const mode of ['day', 'night'] as const) {
      const palette = generatePalette(harmony, 42, 60, mode)
      assert.ok(palette.length >= 2 && palette.length <= 4, `${harmony}/${mode} gave ${palette.length}`)
      for (const color of palette) assert.equal(isHexColor(color), true, `${harmony}/${mode}: ${color}`)
    }
  }
})

test('buildCssGradient spaces its stops evenly and keeps the angle', () => {
  assert.equal(
    buildCssGradient(['#111111', '#222222', '#333333'], 135),
    'linear-gradient(135deg, #111111 0%, #222222 50%, #333333 100%)',
  )
  assert.equal(
    buildCssGradient(['#111111', '#222222'], 0),
    'linear-gradient(0deg, #111111 0%, #222222 100%)',
  )
  // One colour still has to be a usable gradient, not a bare colour string.
  assert.equal(
    buildCssGradient(['#abcdef'], 90),
    'linear-gradient(90deg, #abcdef 0%, #abcdef 100%)',
  )
  // Uppercase is normalised; the angle wraps and keeps its fraction.
  assert.equal(
    buildCssGradient(['#ABCDEF', '#123456'], -45),
    'linear-gradient(315deg, #abcdef 0%, #123456 100%)',
  )
  assert.equal(
    buildCssGradient(['#111111', '#222222'], 22.5),
    'linear-gradient(22.5deg, #111111 0%, #222222 100%)',
  )
})

test('buildCssGradient never passes a non-hex string into CSS', () => {
  // Dropped, not escaped: this string is assigned to a CSS property.
  assert.equal(
    buildCssGradient(['#111111', 'red;}body{display:none', '#222222'], 10),
    'linear-gradient(10deg, #111111 0%, #222222 100%)',
  )
  assert.equal(buildCssGradient([], 45), 'none')
  assert.equal(buildCssGradient(['red', 'rgb(1,2,3)'], 45), 'none')
})
