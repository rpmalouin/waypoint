import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_FRAME_COLOR, FRAME_COLORS, isFrameColor } from '../src/shared/frame-color.ts'

test('the default tint is a valid colour in its own right', () => {
  assert.equal(isFrameColor(DEFAULT_FRAME_COLOR), true)
})

test('the palette is six distinct #rrggbb tints, all of them valid', () => {
  assert.equal(FRAME_COLORS.length, 6)
  assert.equal(new Set(FRAME_COLORS).size, FRAME_COLORS.length, 'no duplicate swatches')
  for (const color of FRAME_COLORS) {
    assert.equal(isFrameColor(color), true, `${color} must pass the guard it is written through`)
  }
})

test('only #rrggbb is accepted, because the value lands in CSS', () => {
  const accepted = ['#7f8ea3', '#FFFFFF', '#000000', '#AbCdEf']
  for (const value of accepted) {
    assert.equal(isFrameColor(value), true, `${value} should be accepted`)
  }
  const rejected = [
    'red',
    '#abc', // shorthand: valid CSS, not the shape the loader documents
    'rgb(1,2,3)',
    '#7f8ea',
    '#7f8ea3f',
    ' #7f8ea3',
    '#7f8ea3;',
    'red;}body{display:none',
    '',
  ]
  for (const value of rejected) {
    assert.equal(isFrameColor(value), false, `${JSON.stringify(value)} should be rejected`)
  }
})

test('non-strings are rejected rather than coerced', () => {
  for (const value of [null, undefined, 42, true, {}, ['#7f8ea3']]) {
    assert.equal(isFrameColor(value), false)
  }
})
