import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_TILE_PARTITION,
  containerChoices,
  containerPrefix,
  isPersistentPartition,
  isTilePartition,
  normalizeTilePartition,
} from '../src/shared/session-partition.ts'

test('the default is the shared persistent jar', () => {
  assert.equal(DEFAULT_TILE_PARTITION, 'persist:main')
  assert.equal(isPersistentPartition(DEFAULT_TILE_PARTITION), true)
})

test('accepts persistent containers, temp containers and bare names', () => {
  const accepted = ['persist:main', 'persist:work', 'persist:a-b_c', 'temp:private', 'private', 'A1', 'x'.repeat(64)]
  for (const value of accepted) {
    assert.equal(isTilePartition(value), true, `${value} should be accepted`)
  }
})

test('rejects anything that could become a path or a surprise', () => {
  const rejected = [
    '',
    'persist:',
    'temp:',
    'persist:../work',
    'persist:work/../main',
    'persist:..',
    'a/b',
    'has space',
    'dot.name',
    'persist:' + 'x'.repeat(65),
    'other:name',
    'persist:persist:x',
    'nul\u0000byte',
  ]
  for (const value of rejected) {
    assert.equal(isTilePartition(value), false, `${JSON.stringify(value)} should be rejected`)
  }
})

test('non-strings are rejected rather than coerced', () => {
  for (const value of [null, undefined, 42, true, {}, ['persist:work']]) {
    assert.equal(isTilePartition(value), false)
  }
})

test('normalize falls back to the shared jar instead of inventing a store', () => {
  assert.equal(normalizeTilePartition(undefined), DEFAULT_TILE_PARTITION)
  assert.equal(normalizeTilePartition('persist:../evil'), DEFAULT_TILE_PARTITION)
  assert.equal(normalizeTilePartition(42), DEFAULT_TILE_PARTITION)
  assert.equal(normalizeTilePartition('persist:work'), 'persist:work')
  assert.equal(normalizeTilePartition('temp:private'), 'temp:private')
})

test('only persist: partitions have a store to flush', () => {
  assert.equal(isPersistentPartition('persist:work'), true)
  assert.equal(isPersistentPartition('temp:private'), false)
  assert.equal(isPersistentPartition('private'), false)
})

// ------------------------------------------------------------- container menus

test('the container menu lists live jars and never the shared one', () => {
  const choices = containerChoices([undefined, DEFAULT_TILE_PARTITION, 'persist:work', 'persist:hoa'])
  assert.deepEqual(choices, [
    { partition: 'persist:hoa', label: 'hoa', persistent: true },
    { partition: 'persist:work', label: 'work', persistent: true },
  ])
})

test('persistent jars lead the menu and in-memory ones follow', () => {
  const choices = containerChoices(['temp:scratch', 'persist:work', 'temp:anon-1a2b3c4d'])
  assert.deepEqual(
    choices.map((choice) => choice.label),
    ['work', 'scratch', 'temp'],
  )
  assert.deepEqual(
    choices.map((choice) => choice.persistent),
    [true, false, false],
  )
})

test('two anonymous temp tiles are one row, because they wear one name', () => {
  const choices = containerChoices(['temp:anon-aaaa1111', 'temp:anon-bbbb2222'])
  assert.equal(choices.length, 1)
  assert.equal(choices[0]?.label, 'temp')
  // The first jar wins: a menu row must name a jar a tile is actually using.
  assert.equal(choices[0]?.partition, 'temp:anon-aaaa1111')
})

test('a malformed partition is not offered as a container', () => {
  assert.deepEqual(containerChoices(['persist:../../etc', 'persist:has space', 'temp:']), [])
})

test('the omnibox prefix rejoins a named jar and mints a new private one', () => {
  assert.equal(containerPrefix('persist:work'), '@work ')
  assert.equal(containerPrefix('temp:scratch'), 'temp:scratch ')
  // A generated name is one tile's private jar: `@temp` is the only honest spelling.
  assert.equal(containerPrefix('temp:anon-1a2b3c4d'), '@temp ')
  // No omnibox spelling produces a bare in-memory name, so none is offered.
  assert.equal(containerPrefix('private'), null)
  assert.equal(containerPrefix(DEFAULT_TILE_PARTITION), null)
  assert.equal(containerPrefix('persist:../evil'), null)
})
