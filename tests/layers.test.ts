import assert from 'node:assert/strict'
import test from 'node:test'
import { moveToEnd, moveToStart, normalizeLayerOrder } from '../src/shared/layers.ts'

/**
 * The layer order is a back-to-front list of tile ids: index 0 is the tile at the
 * back (lowest z-index, first view added). These tests are the specification of
 * that shape and of the absence rule — `undefined` means "this is the creation
 * order", which is the only case that leaves the key out of the saved file.
 */

// --------------------------------------------------------------- move helpers

test('moveToEnd lifts a tile to the front without touching the others', () => {
  assert.deepEqual(moveToEnd(['a', 'b', 'c'], 'b'), ['a', 'c', 'b'])
  assert.deepEqual(moveToEnd(['a', 'b', 'c'], 'c'), ['a', 'b', 'c'])
  assert.deepEqual(moveToEnd(['a', 'b', 'c'], 'a'), ['b', 'c', 'a'])
})

test('moveToStart drops a tile to the back', () => {
  assert.deepEqual(moveToStart(['a', 'b', 'c'], 'c'), ['c', 'a', 'b'])
  assert.deepEqual(moveToStart(['a', 'b', 'c'], 'a'), ['a', 'b', 'c'])
})

test('an unknown id leaves the order alone rather than inventing a position', () => {
  assert.deepEqual(moveToEnd(['a', 'b'], 'ghost'), ['a', 'b'])
  assert.deepEqual(moveToStart(['a', 'b'], 'ghost'), ['a', 'b'])
})

test('the move helpers return a new array and never mutate the input', () => {
  const order = ['a', 'b', 'c']
  const moved = moveToEnd(order, 'a')
  assert.notEqual(moved, order)
  assert.deepEqual(order, ['a', 'b', 'c'])
  moveToStart(order, 'c')
  assert.deepEqual(order, ['a', 'b', 'c'])
})

// ------------------------------------------------------------ normalisation

test('a missing or non-array value is the default, not an error', () => {
  assert.equal(normalizeLayerOrder(undefined, ['a', 'b']), undefined)
  assert.equal(normalizeLayerOrder(null, ['a', 'b']), undefined)
  assert.equal(normalizeLayerOrder('a,b', ['a', 'b']), undefined)
  assert.equal(normalizeLayerOrder({ 0: 'b', 1: 'a' }, ['a', 'b']), undefined)
})

test('an empty order over no tiles is still the default', () => {
  assert.equal(normalizeLayerOrder([], []), undefined)
})

test('unknown ids and duplicates are dropped, not repaired', () => {
  // A repaired id would address nothing; a duplicate would give one tile two
  // positions in a list that must be a total order.
  assert.deepEqual(normalizeLayerOrder(['c', 'c', 'ghost', 'a', 'b', 42, ''], ['a', 'b', 'c']), [
    'c',
    'a',
    'b',
  ])
})

test('tiles missing from the list are appended in tile order, never lost', () => {
  // A hand-edited or older file can name a subset; every live tile still needs a
  // position, or the layer list would show fewer rows than the canvas has tiles.
  assert.deepEqual(normalizeLayerOrder(['c'], ['a', 'b', 'c']), ['c', 'a', 'b'])
})

test('an order equal to the creation order is reported as the default', () => {
  assert.equal(normalizeLayerOrder(['a', 'b', 'c'], ['a', 'b', 'c']), undefined)
  // ...and any difference at all is not.
  assert.deepEqual(normalizeLayerOrder(['a', 'c', 'b'], ['a', 'b', 'c']), ['a', 'c', 'b'])
})

test('every id in the input survives exactly once, and nothing is invented', () => {
  const ids = ['t1', 't2', 't3', 't4']
  for (const raw of [
    undefined,
    [],
    ['t3'],
    ['t4', 't3', 't4'],
    ['ghost', 't2'],
    ['t1', 't2', 't3', 't4'],
    ['t4', 't3', 't2', 't1'],
  ]) {
    const order = normalizeLayerOrder(raw, ids) ?? ids
    assert.deepEqual([...order].sort(), [...ids].sort(), `raw=${JSON.stringify(raw)}`)
    for (const id of order) assert.ok(ids.includes(id), `${id} is not a live tile`)
  }
})
