import assert from 'node:assert/strict'
import test from 'node:test'
import { CASCADE_STEP_WORLD, CHROME_MAX_SCREEN_H, CHROME_MIN_SCREEN_H, CHROME_WORLD_HEIGHT, MAX_ZOOM, MIN_ZOOM } from '../src/shared/constants.ts'
import {
  boundsKey,
  clampZoom,
  classifyWheel,
  groupBounds,
  intersects,
  isNavigableUrl,
  easeCamera,
  layoutTile,
  marqueeHits,
  normalizeUrl,
  overlapArea,
  panByScreen,
  placeNewTile,
  rectsEqual,
  screenToWorld,
  screenToWorldPoint,
  tweenViewport,
  worldToScreen,
  zoomAtPoint,
} from '../src/shared/math.ts'
import type { Rect, Viewport } from '../src/shared/types.ts'

const identity: Viewport = { panX: 0, panY: 0, zoom: 1 }
const tile: Rect = { x: 10, y: 20, width: 300, height: 200 }

test('clampZoom holds the documented 0.25x–2.0x range', () => {
  assert.equal(clampZoom(0.1), MIN_ZOOM)
  assert.equal(clampZoom(9), MAX_ZOOM)
  assert.equal(clampZoom(Number.NaN), 1)
  assert.equal(clampZoom(Number.POSITIVE_INFINITY), 1)
  assert.equal(clampZoom(1.25), 1.25)
})

test('worldToScreen applies (world + pan) * zoom', () => {
  assert.deepEqual(worldToScreen(tile, identity), tile)
  assert.deepEqual(worldToScreen(tile, { panX: 5, panY: -5, zoom: 0.5 }), { x: 8, y: 8, width: 150, height: 100 })
  assert.deepEqual(worldToScreen(tile, { panX: 0, panY: 0, zoom: 2 }), { x: 20, y: 40, width: 600, height: 400 })
})

test('worldToScreen rounds edges so adjacent tiles share an exact edge', () => {
  for (const zoom of [0.25, 0.37, 0.5, 0.77, 1, 1.31, 1.5, 2]) {
    const viewport: Viewport = { panX: 0.4, panY: -0.7, zoom }
    const left = worldToScreen({ x: 0, y: 0, width: 333, height: 111 }, viewport)
    const right = worldToScreen({ x: 333, y: 0, width: 333, height: 111 }, viewport)
    assert.equal(left.x + left.width, right.x, `seam at zoom ${zoom}`)
  }
})

test('screenToWorld inverts worldToScreen', () => {
  const viewport: Viewport = { panX: 137, panY: -42, zoom: 0.63 }
  const screen = worldToScreen(tile, viewport)
  const back = screenToWorld(screen, viewport)
  assert.ok(Math.abs(back.x - tile.x) < 1.6)
  assert.ok(Math.abs(back.width - tile.width) < 3)
})

test('screenToWorldPoint maps the cursor back into world space', () => {
  const viewport: Viewport = { panX: 100, panY: 50, zoom: 2 }
  assert.deepEqual(screenToWorldPoint({ x: 300, y: 250 }, viewport), { x: 50, y: 75 })
})

test('panByScreen moves the world by delta / zoom', () => {
  assert.deepEqual(panByScreen(identity, 100, -40), { panX: 100, panY: -40, zoom: 1 })
  assert.deepEqual(panByScreen({ panX: 0, panY: 0, zoom: 2 }, 100, 100), { panX: 50, panY: 50, zoom: 2 })
})

test('zoomAtPoint keeps the world point under the cursor fixed', () => {
  const start: Viewport = { panX: 40, panY: 25, zoom: 1 }
  const cursor = { x: 512, y: 288 }
  const before = screenToWorldPoint(cursor, start)

  for (const factor of [1.2, 0.8, 1.35, 0.55]) {
    const next = zoomAtPoint(start, cursor, factor)
    const after = screenToWorldPoint(cursor, next)
    assert.ok(Math.abs(after.x - before.x) < 1e-9, `x drifted by ${after.x - before.x}`)
    assert.ok(Math.abs(after.y - before.y) < 1e-9, `y drifted by ${after.y - before.y}`)
  }
})

test('zoomAtPoint clamps instead of escaping the zoom range', () => {
  const zoomedIn = zoomAtPoint(identity, { x: 0, y: 0 }, 10)
  assert.equal(zoomedIn.zoom, MAX_ZOOM)
  const zoomedOut = zoomAtPoint(identity, { x: 0, y: 0 }, 0.001)
  assert.equal(zoomedOut.zoom, MIN_ZOOM)
  assert.equal(zoomAtPoint(identity, { x: 0, y: 0 }, 1), identity, 'a no-op zoom returns the same viewport')
})

test('layoutTile splits the tile into chrome plus content without gaps', () => {
  const layout = layoutTile(tile, identity)
  assert.equal(layout.chrome.height, CHROME_WORLD_HEIGHT)
  assert.equal(layout.chrome.y, layout.tile.y)
  assert.equal(layout.content.y, layout.tile.y + layout.chrome.height)
  assert.equal(layout.content.y + layout.content.height, layout.tile.y + layout.tile.height)
  assert.deepEqual(
    { x: layout.content.x, width: layout.content.width },
    { x: layout.tile.x, width: layout.tile.width },
    'content is the full tile width',
  )
})

test('layoutTile clamps the chrome height on screen', () => {
  const tiny = layoutTile(tile, { panX: 0, panY: 0, zoom: MIN_ZOOM })
  assert.equal(tiny.chrome.height, CHROME_MIN_SCREEN_H)
  const huge = layoutTile(tile, { panX: 0, panY: 0, zoom: MAX_ZOOM })
  assert.equal(huge.chrome.height, CHROME_MAX_SCREEN_H)
  assert.equal(huge.chromeVisible, true)
})

test('layoutTile treats a frame no taller than its bar as collapsed', () => {
  const squat = layoutTile({ x: 0, y: 0, width: 200, height: 4 }, { panX: 0, panY: 0, zoom: 2 })
  assert.equal(squat.collapsed, true)
  assert.equal(squat.chrome.height, squat.tile.height)
  assert.equal(squat.content.height, 0, 'no page pixels under the bar')
})

test('layoutTile never lets chrome eat a tile that still has a body', () => {
  const squat = layoutTile({ x: 0, y: 0, width: 200, height: 40 }, { panX: 0, panY: 0, zoom: 1 })
  assert.equal(squat.collapsed, false)
  assert.ok(squat.chrome.height < squat.tile.height)
  assert.ok(squat.content.height >= 1)
})

test('a tile at the chrome height is a title bar at every zoom', () => {
  for (const zoom of [MIN_ZOOM, 0.5, 1, MAX_ZOOM]) {
    const layout = layoutTile(
      { x: 0, y: 0, width: 760, height: CHROME_WORLD_HEIGHT },
      { panX: 0, panY: 0, zoom },
    )
    assert.equal(layout.collapsed, true, `zoom ${zoom}`)
    assert.equal(layout.content.height, 0, `zoom ${zoom}`)
    assert.equal(layout.chrome.height, layout.tile.height, `zoom ${zoom}`)
  }
})

test('easeCamera is a clamped symmetric in-out curve', () => {
  assert.equal(easeCamera(0), 0)
  assert.equal(easeCamera(1), 1)
  assert.equal(easeCamera(-3), 0, 'clamped below')
  assert.equal(easeCamera(3), 1, 'clamped above')
  assert.ok(Math.abs(easeCamera(0.5) - 0.5) < 1e-9, 'symmetric at the midpoint')
  assert.ok(easeCamera(0.25) < 0.25, 'slow start')
  assert.ok(easeCamera(0.75) > 0.75, 'slow finish')
  assert.ok(easeCamera(0.1) < easeCamera(0.2), 'monotonic')
})

test('tweenViewport interpolates pan and zoom together', () => {
  const from: Viewport = { panX: 0, panY: 0, zoom: 1 }
  const to: Viewport = { panX: -200, panY: 100, zoom: 0.5 }
  assert.deepEqual(tweenViewport(from, to, 0), from)
  assert.deepEqual(tweenViewport(from, to, 1), to)
  assert.deepEqual(tweenViewport(from, to, 0.5), { panX: -100, panY: 50, zoom: 0.75 })
  assert.deepEqual(tweenViewport(from, to, 2), to, 'clamped above')
})

test('boundsKey changes when geometry or zoom changes', () => {
  const a = boundsKey({ x: 0, y: 0, width: 10, height: 10 }, 1)
  assert.equal(a, boundsKey({ x: 0, y: 0, width: 10, height: 10 }, 1))
  assert.notEqual(a, boundsKey({ x: 1, y: 0, width: 10, height: 10 }, 1))
  assert.notEqual(a, boundsKey({ x: 0, y: 0, width: 10, height: 10 }, 1.5))
})

test('rectsEqual compares geometry only', () => {
  assert.equal(rectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }), true)
  assert.equal(rectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 5 }), false)
})

const wheel = (over: Partial<Parameters<typeof classifyWheel>[0]>) => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
})

test('classifyWheel sends discrete notches to zoom', () => {
  const notch = classifyWheel(wheel({ deltaY: -100 }))
  assert.equal(notch.kind, 'zoom')
  if (notch.kind === 'zoom') assert.ok(notch.factor > 1, 'wheel up zooms in')

  const line = classifyWheel(wheel({ deltaY: 3, deltaMode: 1 }))
  assert.equal(line.kind, 'zoom')
  if (line.kind === 'zoom') assert.ok(line.factor < 1, 'wheel down zooms out')
})

test('classifyWheel sends trackpad pixel deltas to pan', () => {
  const intent = classifyWheel(wheel({ deltaX: 3.5, deltaY: 12.25 }))
  assert.equal(intent.kind, 'pan')
  if (intent.kind === 'pan') {
    assert.equal(intent.dx, -3.5)
    assert.equal(intent.dy, -12.25)
  }
})

test('classifyWheel treats ctrl+wheel (pinch) as zoom and caps one gesture', () => {
  const pinch = classifyWheel(wheel({ deltaY: -8, ctrlKey: true }))
  assert.equal(pinch.kind, 'zoom')
  if (pinch.kind === 'zoom') assert.ok(pinch.factor > 1 && pinch.factor <= 2)

  const violent = classifyWheel(wheel({ deltaY: -100000, ctrlKey: true }))
  assert.equal(violent.kind, 'zoom')
  if (violent.kind === 'zoom') assert.equal(violent.factor, 2)
})

test('classifyWheel maps shift+wheel to horizontal pan', () => {
  const intent = classifyWheel(wheel({ deltaY: 20.5, shiftKey: true }))
  assert.equal(intent.kind, 'pan')
  if (intent.kind === 'pan') {
    assert.equal(intent.dy, 0)
    assert.equal(intent.dx, -20.5)
  }
})

test('normalizeUrl accepts full URLs, hosts, localhost and bare phrases', () => {
  assert.equal(normalizeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(normalizeUrl('about:blank'), 'about:blank')
  assert.equal(normalizeUrl('example.com'), 'https://example.com')
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000')
  assert.equal(normalizeUrl('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x')
  assert.equal(normalizeUrl('  '), '')
  assert.match(normalizeUrl('hello world'), /^https:\/\/duckduckgo\.com\/\?q=hello%20world$/)
})

test('isNavigableUrl refuses dangerous schemes', () => {
  assert.equal(isNavigableUrl('https://example.com'), true)
  assert.equal(isNavigableUrl('about:blank'), true)
  assert.equal(isNavigableUrl('file:///tmp/x.html'), true)
  assert.equal(isNavigableUrl('javascript:alert(1)'), false)
  assert.equal(isNavigableUrl('chrome://settings'), false)
  assert.equal(isNavigableUrl('not a url'), false)
  assert.equal(isNavigableUrl(''), false)
})

// ------------------------------------------------------------- placement

const wanted: Rect = { x: 100, y: 100, width: 760, height: 540 }
const big = (x: number, y: number): Rect => ({ x, y, width: 760, height: 540 })

test('intersects/overlapArea treat a shared edge as clear', () => {
  assert.equal(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }), false)
  assert.equal(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 0, width: 10, height: 10 }), true)
  assert.equal(overlapArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }), 0)
  assert.equal(overlapArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }), 25)
})

test('placeNewTile keeps the wanted rect when the canvas is empty or clear', () => {
  assert.deepEqual(placeNewTile(wanted, null, []), wanted)
  assert.deepEqual(placeNewTile(wanted, null, [big(2000, 2000)]), wanted)
})

test('placeNewTile slides right in steps until the tile is clear', () => {
  const focused = big(100, 100)
  // 760-wide tiles at 40px steps need 19 slots to stop overlapping.
  const placed = placeNewTile(wanted, focused, [focused])
  assert.deepEqual(placed, { x: 100 + 19 * CASCADE_STEP_WORLD, y: 100, width: 760, height: 540 })
  assert.equal(intersects(placed, focused), false)
  // Flush adjacency: the new tile's left edge is the focused tile's right edge.
  assert.equal(placed.x, focused.x + focused.width)
})

test('placeNewTile walks past occupied slots instead of giving up', () => {
  const focused = big(100, 100)
  const second: Rect = { x: 140, y: 140, width: 760, height: 540 }
  const placed = placeNewTile(wanted, focused, [focused, second])
  assert.equal(intersects(placed, focused), false)
  assert.equal(intersects(placed, second), false)
  // Clear of the focused tile at slot 19, of the second one only at slot 20.
  assert.deepEqual(placed, { x: 100 + 20 * CASCADE_STEP_WORLD, y: 100, width: 760, height: 540 })
})

test('placeNewTile falls back to the least-bad overlap when every slot is taken', () => {
  const focused = big(100, 100)
  const placed = placeNewTile(wanted, focused, [focused], CASCADE_STEP_WORLD, 2)
  // Nothing is clear within two slots, so the diagonal step wins: it overlaps least.
  assert.deepEqual(placed, { x: 100 + 2 * CASCADE_STEP_WORLD, y: 100 + 2 * CASCADE_STEP_WORLD, width: 760, height: 540 })
})

test('placeNewTile ignores a non-finite wanted rect rather than cascading into nonsense', () => {
  const broken: Rect = { x: Number.NaN, y: 0, width: 760, height: 540 }
  assert.deepEqual(placeNewTile(broken, big(0, 0), [big(0, 0)]), broken)
})

// ------------------------------------------------------------ rubberband select

/** A tile-shaped item at a world origin, sized like a small tile. */
const item = (id: string, x: number, y: number, width = 100, height = 80): { id: string; world: Rect } => ({
  id,
  world: { x, y, width, height },
})

test('a rubberband selects every tile it overlaps, in world units', () => {
  const tiles = [item('a', 0, 0), item('b', 300, 0), item('c', 0, 300)]
  assert.deepEqual(marqueeHits({ x: -10, y: -10, width: 200, height: 120 }, tiles), ['a'])
  assert.deepEqual(marqueeHits({ x: -10, y: -10, width: 500, height: 120 }, tiles), ['a', 'b'])
  assert.deepEqual(marqueeHits({ x: -50, y: -50, width: 2000, height: 2000 }, tiles), ['a', 'b', 'c'])
})

test('a rubberband that only shares an edge selects nothing', () => {
  const tiles = [item('a', 0, 0)]
  assert.deepEqual(marqueeHits({ x: 100, y: 0, width: 50, height: 80 }, tiles), [], 'flush to the right')
  assert.deepEqual(marqueeHits({ x: 0, y: 80, width: 100, height: 50 }, tiles), [], 'flush below')
  assert.deepEqual(marqueeHits({ x: 99, y: 79, width: 10, height: 10 }, tiles), ['a'], 'one pixel of overlap counts')
})

test('the hit test runs in world space, so a fixed screen box covers less at 2x', () => {
  const tiles = [item('a', 0, 0), item('b', 300, 0)]
  const screenRect: Rect = { x: -10, y: -10, width: 400, height: 120 }
  const identityView: Viewport = { panX: 0, panY: 0, zoom: 1 }
  assert.deepEqual(marqueeHits(screenToWorld(screenRect, identityView), tiles), ['a', 'b'])
  // Twice the zoom, same pixels dragged: half the world, so the second tile falls out.
  assert.deepEqual(marqueeHits(screenToWorld(screenRect, { panX: 0, panY: 0, zoom: 2 }), tiles), ['a'])
})

// ---------------------------------------------------------------- group frames

test('a group frame covers only the selected tiles', () => {
  const tiles = [item('a', 0, 0), item('b', 300, 0), item('c', 0, 300)]
  assert.deepEqual(groupBounds(tiles, new Set(['a', 'b'])), { x: 0, y: 0, width: 400, height: 80 })
})

test('with nothing selected a group frame covers every tile', () => {
  const tiles = [item('a', 0, 0), item('b', 300, 0), item('c', 0, 300)]
  assert.deepEqual(groupBounds(tiles, new Set()), { x: 0, y: 0, width: 400, height: 380 })
})

test('a selection that addresses no live tile bounds nothing', () => {
  assert.equal(groupBounds([item('a', 0, 0)], new Set(['gone'])), null)
  assert.equal(groupBounds([], new Set()), null)
})

