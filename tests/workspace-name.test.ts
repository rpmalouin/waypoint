import assert from 'node:assert/strict'
import test from 'node:test'
import { WORKSPACE_NAME_MAX } from '../src/shared/constants.ts'
import { isValidWorkspaceName, sanitizeWorkspaceName } from '../src/shared/workspace-name.ts'

test('sanitizeWorkspaceName lowercases and hyphenates', () => {
  assert.equal(sanitizeWorkspaceName('My Workspace!'), 'my-workspace')
  assert.equal(sanitizeWorkspaceName('  smoke-test  '), 'smoke-test')
  assert.equal(sanitizeWorkspaceName('Research: AI/ML'), 'research-ai-ml')
  assert.equal(sanitizeWorkspaceName('a---b'), 'a-b')
})

test('sanitizeWorkspaceName strips path separators and traversal', () => {
  const traversals = ['../etc/passwd', '../../..', '/etc/hosts', '..', '.', '..\\..\\windows']
  for (const raw of traversals) {
    const name = sanitizeWorkspaceName(raw)
    assert.ok(!name.includes('..'), `${raw} -> ${name} still has ".."`)
    assert.ok(!name.includes('/'), `${raw} -> ${name} still has a slash`)
    assert.ok(!name.startsWith('.'), `${raw} -> ${name} starts with a dot`)
    if (name) assert.ok(isValidWorkspaceName(name), `${raw} -> ${name} is not a valid name`)
  }
})

test('sanitizeWorkspaceName bounds the length', () => {
  const name = sanitizeWorkspaceName('x'.repeat(200))
  assert.equal(name.length, WORKSPACE_NAME_MAX)
  assert.ok(isValidWorkspaceName(name))
})

test('isValidWorkspaceName rejects anything outside the allowlist', () => {
  assert.equal(isValidWorkspaceName('smoke-test'), true)
  assert.equal(isValidWorkspaceName('a.b_c-1'), true)
  assert.equal(isValidWorkspaceName(''), false)
  assert.equal(isValidWorkspaceName('-leading'), false)
  assert.equal(isValidWorkspaceName('UPPER'), false)
  assert.equal(isValidWorkspaceName('has space'), false)
  assert.equal(isValidWorkspaceName('dot..dot'), false)
  assert.equal(isValidWorkspaceName('a/b'), false)
  assert.equal(isValidWorkspaceName(`${'x'.repeat(WORKSPACE_NAME_MAX)}y`), false)
})

test('sanitize then validate is stable for already-valid names', () => {
  for (const name of ['scratch', 'work-2026', 'a.b_c']) {
    assert.equal(sanitizeWorkspaceName(name), name)
    assert.ok(isValidWorkspaceName(name))
  }
})
