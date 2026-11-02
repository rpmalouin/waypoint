import assert from 'node:assert/strict'
import test from 'node:test'
import { MIN_FRAME_WORLD_H, MIN_FRAME_WORLD_W, MIN_TILE_WORLD_H, MIN_TILE_WORLD_W } from '../src/shared/constants.ts'
import {
  containsPoint,
  frameRect,
  idsInsideFrame,
  padRect,
  rectCentre,
  rectUnion,
  resizeFree,
  translateRect,
} from '../src/shared/math.ts'
import type { Corner } from '../src/shared/math.ts'
import type { Rect } from '../src/shared/types.ts'

const origin: Rect = { x: 100, y: 100, width: 400, height: 300 }

// --------------------------------------------------------------- frame rect

test('frameRect flattens a record into the rect the geometry code uses', () => {
  assert.deepEqual(frameRect({ worldX: -40, worldY: 12, worldW: 800, worldH: 600 }), {
    x: -40,
    y: 12,
    width: 800,
    height: 600,
  })
})

test('containsPoint includes the border, so touching zones cannot lose a tile', () => {
  const zone: Rect = { x: 0, y: 0, width: 100, height: 100 }
  assert.equal(containsPoint(zone, { x: 50, y: 50 }), true)
  assert.equal(containsPoint(zone, { x: 0, y: 0 }), true, 'top-left corner')
  assert.equal(containsPoint(zone, { x: 100, y: 100 }), true, 'bottom-right corner')
  assert.equal(containsPoint(zone, { x: 100.5, y: 50 }), false)
  assert.equal(containsPoint(zone, { x: -0.5, y: 50 }), false)
})

test('rectCentre is the point a zone drag tests against', () => {
  assert.deepEqual(rectCentre({ x: -100, y: 40, width: 400, height: 200 }), { x: 100, y: 140 })
})

// ------------------------------------------------------ collective carry

test('idsInsideFrame selects by centre, not by origin', () => {
  const zone: Rect = { x: 0, y: 0, width: 500, height: 400 }
  const items = [
    // Centre inside: follows the zone.
    { id: 'inside', world: { x: 100, y: 100, width: 200, height: 100 } },
    // Origin inside, centre outside the right edge: stays put.
    { id: 'straddling', world: { x: 380, y: 100, width: 400, height: 100 } },
    // Entirely outside.
    { id: 'outside', world: { x: 900, y: 900, width: 100, height: 100 } },
  ]
  assert.deepEqual(idsInsideFrame(zone, items), ['inside'])
})

test('every tile a zone carries moves by exactly the same offset', () => {
  const zone: Rect = { x: 0, y: 0, width: 900, height: 700 }
  const items = [
    { id: 'a', world: { x: 40, y: 40, width: 300, height: 200 } },
    { id: 'b', world: { x: 500, y: 420, width: 300, height: 200 } },
  ]
  const carried = idsInsideFrame(zone, items)
  assert.deepEqual(carried, ['a', 'b'])

  const dx = 137
  const dy = -42
  const moved = items.map((item) => ({ id: item.id, world: translateRect(item.world, dx, dy) }))
  assert.deepEqual(
    moved.map((item) => item.world),
    [
      { x: 177, y: -2, width: 300, height: 200 },
      { x: 637, y: 378, width: 300, height: 200 },
    ],
  )
  // The offset is rigid: every rect keeps its size and shifts by the same vector.
  for (let index = 0; index < items.length; index += 1) {
    const before = items[index]!.world
    const after = moved[index]!.world
    assert.equal(after.width, before.width)
    assert.equal(after.height, before.height)
    assert.equal(after.x - before.x, dx)
    assert.equal(after.y - before.y, dy)
  }
  // ...and after the move the tiles are still inside the moved zone.
  const movedZone = translateRect(zone, dx, dy)
  assert.deepEqual(
    idsInsideFrame(movedZone, moved),
    ['a', 'b'],
  )
})

test('⌘G bounds: rectUnion of a selection plus padding', () => {
  const selection: Rect[] = [
    { x: -100, y: 200, width: 300, height: 200 },
    { x: 400, y: -50, width: 200, height: 100 },
  ]
  const union = rectUnion(selection)
  assert.ok(union)
  assert.deepEqual(union, { x: -100, y: -50, width: 700, height: 450 })
  assert.deepEqual(padRect(union, 48), { x: -148, y: -98, width: 796, height: 546 })
  assert.equal(rectUnion([]), null)
})

// ------------------------------------------------------------- free resize

const expectRects: Array<{ corner: Corner; dx: number; dy: number; rect: Rect }> = [
  // Dragging the south-east corner moves nothing but the size.
  { corner: 'se', dx: 50, dy: -40, rect: { x: 100, y: 100, width: 450, height: 260 } },
  // Dragging the north-west corner moves the origin and keeps the SE corner.
  { corner: 'nw', dx: 50, dy: 40, rect: { x: 150, y: 140, width: 350, height: 260 } },
  // North-east: width grows, height shrinks, the top edge moves.
  { corner: 'ne', dx: 50, dy: 40, rect: { x: 100, y: 140, width: 450, height: 260 } },
  // South-west: width shrinks, height grows, the left edge moves.
  { corner: 'sw', dx: 50, dy: 40, rect: { x: 150, y: 100, width: 350, height: 340 } },
]

test('resizeFree maps each corner to the axes it moves', () => {
  for (const { corner, dx, dy, rect } of expectRects) {
    assert.deepEqual(resizeFree(origin, corner, dx, dy, MIN_TILE_WORLD_W, MIN_TILE_WORLD_H), rect, corner)
  }
})

test('resizeFree anchors the opposite corner for every handle', () => {
  const anchors: Record<Corner, { x: number; y: number }> = {
    se: { x: origin.x, y: origin.y },
    nw: { x: origin.x + origin.width, y: origin.y + origin.height },
    ne: { x: origin.x, y: origin.y + origin.height },
    sw: { x: origin.x + origin.width, y: origin.y },
  }
  for (const corner of ['nw', 'ne', 'se', 'sw'] as const) {
    const rect = resizeFree(origin, corner, 37, -23, MIN_TILE_WORLD_W, MIN_TILE_WORLD_H)
    const anchor = anchors[corner]
    const keptX = corner === 'nw' || corner === 'sw' ? rect.x + rect.width : rect.x
    const keptY = corner === 'nw' || corner === 'ne' ? rect.y + rect.height : rect.y
    assert.equal(keptX, anchor.x, `${corner} x anchor`)
    assert.equal(keptY, anchor.y, `${corner} y anchor`)
  }
})

test('resizeFree clamps to the minimum without flipping through the anchor', () => {
  const minWidth = 320
  const minHeight = 240
  // Shrinking each corner past the minimum pins the moving edge at min* away
  // from the anchor instead of turning the rect inside out.
  const shrunk: Array<{ corner: Corner; dx: number; dy: number; x: number; y: number }> = [
    { corner: 'se', dx: -900, dy: -900, x: 100, y: 100 },
    { corner: 'nw', dx: 900, dy: 900, x: 500 - minWidth, y: 400 - minHeight },
    { corner: 'ne', dx: -900, dy: 900, x: 100, y: 400 - minHeight },
    { corner: 'sw', dx: 900, dy: -900, x: 500 - minWidth, y: 100 },
  ]
  for (const { corner, dx, dy, x, y } of shrunk) {
    const rect = resizeFree(origin, corner, dx, dy, minWidth, minHeight)
    assert.equal(rect.width, minWidth, `${corner} width`)
    assert.equal(rect.height, minHeight, `${corner} height`)
    assert.equal(rect.x, x, `${corner} x`)
    assert.equal(rect.y, y, `${corner} y`)
  }
})

test('a frame is never resized below the size its header needs', () => {
  const small: Rect = { x: 0, y: 0, width: MIN_FRAME_WORLD_W, height: MIN_FRAME_WORLD_H }
  const shrunk = resizeFree(small, 'se', -500, -500, MIN_FRAME_WORLD_W, MIN_FRAME_WORLD_H)
  assert.deepEqual(shrunk, small)
})
