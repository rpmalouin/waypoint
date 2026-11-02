import assert from 'node:assert/strict'
import test from 'node:test'
import { FIT_MAX_ZOOM, FIT_PADDING, MAX_ZOOM, MIN_ZOOM } from '../src/shared/constants.ts'
import { fitToView, panTileToCenter, panToCenter, resetZoom, screenToWorldPoint, worldToScreen } from '../src/shared/math.ts'
import type { Rect, Viewport } from '../src/shared/types.ts'

const view = { width: 1200, height: 800 }
const identity: Viewport = { panX: 0, panY: 0, zoom: 1 }

/** The property that matters: after the move, the point projects to the centre. */
function screenCentre(world: { x: number; y: number }, viewport: Viewport): { x: number; y: number } {
  const rect = worldToScreen({ x: world.x, y: world.y, width: 0, height: 0 }, viewport)
  return { x: rect.x, y: rect.y }
}

test('panToCenter puts a world point at the centre of the view', () => {
  const world = { x: 320, y: -180 }
  const moved = panToCenter(world, identity, view)
  const centre = screenCentre(world, moved)
  assert.equal(centre.x, view.width / 2)
  assert.equal(centre.y, view.height / 2)
})

test('panToCenter preserves zoom and never changes it', () => {
  for (const zoom of [MIN_ZOOM, 0.4, 0.75, 1, 1.5, MAX_ZOOM]) {
    const moved = panToCenter({ x: 42, y: 42 }, { panX: 10, panY: 10, zoom }, view)
    assert.equal(moved.zoom, zoom)
  }
})

test('panToCenter is exact at every zoom, not just 1x', () => {
  for (const zoom of [MIN_ZOOM, 0.33, 0.5, 1, 1.25, 2]) {
    const viewport: Viewport = { panX: -900, panY: 640, zoom }
    const world = { x: 1500, y: -2200 }
    const moved = panToCenter(world, viewport, view)
    const centre = screenCentre(world, moved)
    assert.ok(Math.abs(centre.x - view.width / 2) < 1e-9, `zoom ${zoom} x: ${centre.x}`)
    assert.ok(Math.abs(centre.y - view.height / 2) < 1e-9, `zoom ${zoom} y: ${centre.y}`)
  }
})

test('panToCenter clamps a zoom that is out of range', () => {
  const moved = panToCenter({ x: 0, y: 0 }, { panX: 0, panY: 0, zoom: 99 }, view)
  assert.equal(moved.zoom, MAX_ZOOM)
  const tiny = panToCenter({ x: 0, y: 0 }, { panX: 0, panY: 0, zoom: 0.01 }, view)
  assert.equal(tiny.zoom, MIN_ZOOM)
})

test('panTileToCenter centres the tile midpoint, not its origin', () => {
  const rect: Rect = { x: -400, y: 260, width: 760, height: 540 }
  const viewport: Viewport = { panX: 31, panY: -77, zoom: 0.62 }
  const moved = panTileToCenter(rect, viewport, view)
  const midpoint = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  const centre = screenCentre(midpoint, moved)
  assert.ok(Math.abs(centre.x - view.width / 2) < 1e-9)
  assert.ok(Math.abs(centre.y - view.height / 2) < 1e-9)
  // Origin must NOT be centred: that would cut the tile in half.
  const origin = screenCentre({ x: rect.x, y: rect.y }, moved)
  assert.ok(origin.x < view.width / 2)
})

test('panTileToCenter is idempotent: centring twice does not drift', () => {
  const rect: Rect = { x: 120, y: 90, width: 300, height: 200 }
  const once = panTileToCenter(rect, identity, view)
  const twice = panTileToCenter(rect, once, view)
  assert.deepEqual(twice, once)
})

test('panToCenter round-trips through screenToWorldPoint', () => {
  const world = { x: -150, y: 75 }
  const moved = panToCenter(world, identity, { width: 640, height: 480 })
  const back = screenToWorldPoint({ x: 320, y: 240 }, moved)
  assert.ok(Math.abs(back.x - world.x) < 1e-9)
  assert.ok(Math.abs(back.y - world.y) < 1e-9)
})

test('fitToView returns null with nothing to fit', () => {
  assert.equal(fitToView([], identity, view, 72), null)
})

test('fitToView keeps every rect inside the padded viewport', () => {
  const worlds: Rect[] = [
    { x: -1200, y: -800, width: 760, height: 540 },
    { x: 1800, y: 1400, width: 320, height: 240 },
  ]
  const fitted = fitToView(worlds, identity, view, 72)
  assert.ok(fitted)
  for (const world of worlds) {
    const screen = worldToScreen(world, fitted)
    assert.ok(screen.x >= 72 - 1e-9, `left ${screen.x}`)
    assert.ok(screen.y >= 72 - 1e-9, `top ${screen.y}`)
    assert.ok(screen.x + screen.width <= view.width - 72 + 1e-9, `right ${screen.x + screen.width}`)
    assert.ok(screen.y + screen.height <= view.height - 72 + 1e-9, `bottom ${screen.y + screen.height}`)
  }
})

test('fitToView never exceeds the fit cap, even for one small tile', () => {
  const small: Rect[] = [{ x: 0, y: 0, width: 100, height: 100 }]
  const fitted = fitToView(small, { panX: 0, panY: 0, zoom: 0.5 }, view, FIT_PADDING)
  assert.ok(fitted)
  assert.equal(fitted.zoom, FIT_MAX_ZOOM)
})

// The sidebar's click-to-pan is this formula, spelled out: the camera lands so
// the tile's midpoint sits at the view centre, at the zoom the user already had.
test('panTileToCenter matches the documented pan-to-focus formula', () => {
  const rect: Rect = { x: -640, y: 220, width: 760, height: 540 }
  const viewport: Viewport = { panX: 12, panY: -30, zoom: 0.8 }
  const moved = panTileToCenter(rect, viewport, view)
  const expectedX = view.width / 2 / viewport.zoom - (rect.x + rect.width / 2)
  const expectedY = view.height / 2 / viewport.zoom - (rect.y + rect.height / 2)
  assert.ok(Math.abs(moved.panX - expectedX) < 1e-9, `panX ${moved.panX} != ${expectedX}`)
  assert.ok(Math.abs(moved.panY - expectedY) < 1e-9, `panY ${moved.panY} != ${expectedY}`)
  assert.equal(moved.zoom, viewport.zoom)
})

// Fit is a bounding-box calculation across every tile, then one zoom that makes
// that box fit inside the padded view. Both halves are asserted against a box
// whose size is obvious by hand, so a wrong axis or an unclamped zoom shows up.
test('fitToView zooms to the padded bounding box of every tile', () => {
  const worlds: Rect[] = [
    { x: 0, y: 0, width: 400, height: 300 },
    { x: 1000, y: 600, width: 400, height: 300 },
  ]
  // Bounding box 0,0 -> 1400,900; available 1200-2*40 x 800-2*40 = 1120x720.
  const expected = Math.min(FIT_MAX_ZOOM, (view.width - FIT_PADDING * 2) / 1400, (view.height - FIT_PADDING * 2) / 900)
  const fitted = fitToView(worlds, identity, view, FIT_PADDING)
  assert.ok(fitted)
  assert.ok(Math.abs(fitted.zoom - expected) < 1e-12, `zoom ${fitted.zoom} != ${expected}`)
  // ...and the box's own centre lands on the view centre.
  const centre = screenCentre({ x: 700, y: 450 }, fitted)
  assert.ok(Math.abs(centre.x - view.width / 2) < 1e-9)
  assert.ok(Math.abs(centre.y - view.height / 2) < 1e-9)
})

test('fitToView scales down for a cluster larger than the view', () => {
  const wide: Rect[] = [
    { x: 0, y: 0, width: 760, height: 540 },
    { x: 3000, y: 0, width: 760, height: 540 },
  ]
  const fitted = fitToView(wide, identity, view, 72)
  assert.ok(fitted)
  assert.ok(fitted.zoom < 1)
  assert.ok(fitted.zoom >= MIN_ZOOM)
})

test('fitToView survives non-finite coordinates', () => {
  const worlds: Rect[] = [
    { x: Number.NaN, y: 0, width: 10, height: 10 },
    { x: 100, y: 100, width: 200, height: 120 },
  ]
  const fitted = fitToView(worlds, identity, view, 72)
  assert.ok(fitted)
  assert.ok(Number.isFinite(fitted.panX) && Number.isFinite(fitted.panY))
})

test('resetZoom returns to 100% while holding the centre still', () => {
  const zoomed: Viewport = { panX: -2400, panY: 820, zoom: 0.5 }
  const centreBefore = screenToWorldPoint({ x: 600, y: 400 }, zoomed)
  const reset = resetZoom(zoomed, view)
  assert.equal(reset.zoom, 1)
  const centreAfter = screenToWorldPoint({ x: 600, y: 400 }, reset)
  assert.ok(Math.abs(centreAfter.x - centreBefore.x) < 1e-9)
  assert.ok(Math.abs(centreAfter.y - centreBefore.y) < 1e-9)
})

test('resetZoom is a no-op at 100%', () => {
  const same = resetZoom(identity, view)
  assert.equal(same, identity)
})
