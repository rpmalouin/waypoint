import assert from 'node:assert/strict'
import test from 'node:test'
import { initialPanMode, reducePanMode } from '../src/shared/pan-mode.ts'
import type { PanModeEvent, PanModeState } from '../src/shared/pan-mode.ts'

const run = (events: PanModeEvent[]): PanModeState => events.reduce(reducePanMode, initialPanMode())
const latched = (): PanModeState => reducePanMode(initialPanMode(), { type: 'tool', pan: true })

/** A key event the type no longer admits: the point is that the machine ignores it. */
const key = (type: 'keydown' | 'keyup', code = 'Space'): PanModeEvent =>
  ({ type, code }) as unknown as PanModeEvent

test('starts disarmed, so the interceptor swallows no clicks', () => {
  const state = initialPanMode()
  assert.equal(state.armed, false)
  assert.equal(state.toolPan, false)
})

test('Space does not arm the interceptor', () => {
  const down = reducePanMode(initialPanMode(), key('keydown'))
  assert.equal(down.armed, false, 'Space is a character, not a pan key')
  assert.deepEqual(down, initialPanMode(), 'a key event must not change the state at all')
})

test('Space does not disturb a latched hand tool, in either direction', () => {
  const on = latched()
  assert.equal(on.armed, true)
  assert.equal(reducePanMode(on, key('keydown')), on, 'keydown must return the identical state')
  assert.equal(reducePanMode(on, key('keyup')), on, 'keyup equally')
  const off = reducePanMode(on, { type: 'tool', pan: false })
  assert.equal(reducePanMode(off, key('keydown')).armed, false, 'a stray key cannot arm')
})

test('the hand tool latches the interceptor and only the tool unlatches it', () => {
  const on = latched()
  assert.equal(on.armed, true)
  const off = reducePanMode(on, { type: 'tool', pan: false })
  assert.equal(off.armed, false)
  assert.equal(off.toolPan, false)
})

test('a modal wins over the tool, and closing it re-arms the hand that is still latched', () => {
  const state = reducePanMode(latched(), { type: 'modal', open: true })
  assert.equal(state.armed, false, 'a modal needs the clicks the interceptor would take')
  const closed = reducePanMode(state, { type: 'modal', open: false })
  assert.equal(closed.armed, true)
})

test('state is only replaced when armed actually changes', () => {
  const on = latched()
  const start = initialPanMode()
  assert.equal(reducePanMode(on, { type: 'tool', pan: true }), on, 'a repeat event must not allocate')
  assert.equal(reducePanMode(start, { type: 'modal', open: false }), start)
  assert.equal(reducePanMode(start, { type: 'tool', pan: false }), start)
  assert.notEqual(reducePanMode(on, { type: 'modal', open: true }), on)
})

test('any unlatched state stays disarmed whatever arrives', () => {
  const state = run([
    { type: 'tool', pan: false },
    { type: 'modal', open: true },
    { type: 'modal', open: false },
    key('keydown'),
    key('keyup'),
  ])
  assert.deepEqual(state, initialPanMode())
})
