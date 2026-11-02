import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_TILE_PARTITION,
  containerLabel,
  isPersistentPartition,
  isTilePartition,
  parseOmniboxInput,
} from '../src/shared/session-partition.ts'

/** Deterministic stand-in for the generated `@temp` name. */
const suffix = (value = 'deadbeef') => (): string => value

test('@name opens a persistent container', () => {
  assert.deepEqual(parseOmniboxInput('@work https://github.com'), {
    target: 'https://github.com',
    partition: 'persist:work',
  })
  assert.deepEqual(parseOmniboxInput('  @hoa   https://bank.example/login  '), {
    target: 'https://bank.example/login',
    partition: 'persist:hoa',
  })
})

test('name:url is the same statement as @name', () => {
  assert.deepEqual(parseOmniboxInput('work:https://github.com'), {
    target: 'https://github.com',
    partition: 'persist:work',
  })
  assert.deepEqual(parseOmniboxInput('work:example.com'), {
    target: 'example.com',
    partition: 'persist:work',
  })
})

test('the canonical persist:/temp: spelling is accepted verbatim', () => {
  assert.deepEqual(parseOmniboxInput('persist:work https://github.com'), {
    target: 'https://github.com',
    partition: 'persist:work',
  })
  assert.deepEqual(parseOmniboxInput('temp:scratch https://example.com'), {
    target: 'https://example.com',
    partition: 'temp:scratch',
  })
})

test('a bare URL, host, port or search phrase stays in the shared jar', () => {
  for (const input of [
    'https://example.com',
    'http://example.com:8080/a',
    'example.com',
    'localhost:3000',
    'localhost:3000/path',
    'example.com:8080/path',
    'about:blank',
    'data:text/html,hi',
    'file:///tmp/x.html',
    'two words',
    'gemini',
  ]) {
    assert.deepEqual(parseOmniboxInput(input), { target: input, partition: DEFAULT_TILE_PARTITION }, input)
  }
})

test('@temp gets a fresh in-memory container, not a shared one', () => {
  const first = parseOmniboxInput('@temp https://example.com', suffix('a1b2c3d4'))
  assert.deepEqual(first, { target: 'https://example.com', partition: 'temp:anon-a1b2c3d4' })
  assert.equal(isTilePartition(first.partition), true)
  assert.equal(isPersistentPartition(first.partition), false)

  // The colon spelling means the same thing.
  assert.equal(parseOmniboxInput('temp:https://example.com', suffix('0f0f0f0f')).partition, 'temp:anon-0f0f0f0f')

  // Two private tiles must not share a jar: the generated names differ.
  assert.notEqual(
    parseOmniboxInput('@temp https://example.com').partition,
    parseOmniboxInput('@temp https://example.com').partition,
  )
})

test('hostile or malformed prefixes fall back to the shared jar', () => {
  const hostile = [
    '@../../bad https://example.com',
    '@work/../main https://example.com',
    `@${'x'.repeat(65)} https://example.com`,
    '@nul\u0000byte https://example.com',
    '@temp/../x https://example.com',
    '@a.b https://example.com',
  ]
  for (const input of hostile) {
    const parsed = parseOmniboxInput(input, suffix())
    assert.equal(parsed.partition, DEFAULT_TILE_PARTITION, input)
    assert.equal(isTilePartition(parsed.partition), true, input)
  }

  // The address the user typed is still opened — the container is what is refused.
  assert.deepEqual(parseOmniboxInput('@../../bad https://example.com'), {
    target: 'https://example.com',
    partition: DEFAULT_TILE_PARTITION,
  })
})

test('a prefix with nothing after it asks for nothing', () => {
  assert.deepEqual(parseOmniboxInput('@work'), { target: '', partition: 'persist:work' })
  assert.deepEqual(parseOmniboxInput('@temp', suffix('aaaaaaaa')), { target: '', partition: 'temp:anon-aaaaaaaa' })
  assert.deepEqual(parseOmniboxInput(''), { target: '', partition: DEFAULT_TILE_PARTITION })
})

test('@main names the shared jar, so no badge is invented for it', () => {
  assert.deepEqual(parseOmniboxInput('@main https://example.com'), {
    target: 'https://example.com',
    partition: DEFAULT_TILE_PARTITION,
  })
  assert.equal(containerLabel(parseOmniboxInput('@main').partition), null)
})

test('every parsed partition is one main will accept', () => {
  const inputs = [
    '@work https://example.com',
    'work:example.com',
    '@temp https://example.com',
    'temp:scratch https://example.com',
    'persist:work https://example.com',
    'https://example.com',
    'localhost:3000',
    '@../../../etc https://example.com',
    '@',
    '',
  ]
  for (const input of inputs) {
    assert.equal(isTilePartition(parseOmniboxInput(input).partition), true, input)
  }
})

test('the badge label names the container, not the storage key', () => {
  assert.equal(containerLabel(DEFAULT_TILE_PARTITION), null)
  assert.equal(containerLabel('persist:work'), 'work')
  assert.equal(containerLabel('persist:hoa'), 'hoa')
  assert.equal(containerLabel('temp:scratch'), 'scratch')
  // A generated name is noise in a 14px pill; the useful fact is `temp`.
  assert.equal(containerLabel('temp:anon-a1b2c3d4'), 'temp')
  // A bare name is Electron's own in-memory spelling.
  assert.equal(containerLabel('scratch'), 'scratch')
})
