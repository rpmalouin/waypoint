import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from 'electron'
import { Adblocker } from '../src/main/adblock.ts'
import {
  decideRequest,
  hostOf,
  isBlockedHost,
  parseBlocklist,
  sameSite,
} from '../src/shared/adblock.ts'

const LIST = parseBlocklist(
  [
    '# comment line',
    'adnxs.com',
    '',
    '  doubleclick.net  ',
    '*.pubmatic.com',
    'google-analytics.com',
    'not a host',
    'x'.repeat(300),
  ].join('\n'),
)

test('parseBlocklist drops comments, blanks and junk, and normalises the rest', () => {
  assert.deepEqual([...LIST].sort(), ['adnxs.com', 'doubleclick.net', 'google-analytics.com', 'pubmatic.com'])
})

test('parseBlocklist dedupes and lowercases', () => {
  const parsed = parseBlocklist('AdNxS.com\nadnxs.com\nADNXS.COM\n')
  assert.deepEqual([...parsed], ['adnxs.com'])
})

test('hostOf reads http(s) hosts and refuses everything else', () => {
  assert.equal(hostOf('https://ib.adnxs.com/getuid?x=1'), 'ib.adnxs.com')
  assert.equal(hostOf('HTTP://Example.COM:8443/path'), 'example.com')
  assert.equal(hostOf('https://example.com./x'), 'example.com')
  for (const url of [
    'file:///home/user/x.html',
    'data:text/html,hi',
    'about:blank',
    'blob:https://example.com/1234',
    'chrome-extension://abc/page.html',
    'not a url',
    '',
  ]) {
    assert.equal(hostOf(url), null, `${url} has no http(s) host`)
  }
})

test('isBlockedHost matches the host itself and its subdomains', () => {
  assert.equal(isBlockedHost('adnxs.com', LIST), true)
  assert.equal(isBlockedHost('ib.adnxs.com', LIST), true)
  assert.equal(isBlockedHost('deep.nested.doubleclick.net', LIST), true)
  assert.equal(isBlockedHost('ib.adnxs.com.', LIST), true, 'a trailing dot is the same host')
})

test('isBlockedHost does not match a lookalike that merely contains the entry', () => {
  assert.equal(isBlockedHost('notadnxs.com', LIST), false)
  assert.equal(isBlockedHost('adnxs.com.evil.example', LIST), false)
  assert.equal(isBlockedHost('example.com', LIST), false)
  assert.equal(isBlockedHost('', LIST), false)
})

test('an IP literal is matched exactly, not as a parent name', () => {
  const withIp = parseBlocklist('1.2.3.4\n')
  assert.equal(isBlockedHost('1.2.3.4', withIp), true)
  assert.equal(isBlockedHost('5.6.7.8', withIp), false)
  // Suffix matching still applies literally: a "host" ending in the listed
  // labels matches. No real hostname looks like that, so this is a curiosity
  // rather than a hole — recorded so a future reader does not think it is one.
  assert.equal(isBlockedHost('9.1.2.3.4', withIp), true)
})

test('sameSite treats subdomains as one site, and lookalikes as two', () => {
  assert.equal(sameSite('example.com', 'example.com'), true)
  assert.equal(sameSite('cdn.example.com', 'example.com'), true)
  assert.equal(sameSite('example.com', 'www.example.com'), true)
  assert.equal(sameSite('evilexample.com', 'example.com'), false)
  // Documented limitation: no public-suffix list, so siblings under a
  // multi-part suffix are not recognised as one site.
  assert.equal(sameSite('a.example.co.uk', 'b.example.co.uk'), false)
})

test('a top-level navigation is never blocked, even to a listed host', () => {
  const decision = decideRequest({ url: 'https://ib.adnxs.com/', isMainFrame: true }, LIST)
  assert.deepEqual(decision, { block: false, reason: 'main-frame', host: null })
})

test('non-http requests are left alone', () => {
  const decision = decideRequest({ url: 'file:///tmp/x.png' }, LIST)
  assert.equal(decision.block, false)
  assert.equal(decision.reason, 'not-http')
})

test('a third-party request to a listed host is blocked, and says which host', () => {
  const decision = decideRequest(
    { url: 'https://ib.adnxs.com/getuid', firstPartyHost: 'theverge.com' },
    LIST,
  )
  assert.deepEqual(decision, { block: true, reason: 'listed', host: 'ib.adnxs.com' })
})

test('a same-site request is allowed even when the site is on the list', () => {
  const decision = decideRequest(
    { url: 'https://ads.doubleclick.net/x', firstPartyHost: 'doubleclick.net' },
    LIST,
  )
  assert.equal(decision.block, false)
  assert.equal(decision.reason, 'same-site')
})

test('an unlisted third-party request is allowed', () => {
  const decision = decideRequest(
    { url: 'https://cdn.example.com/app.js', firstPartyHost: 'theverge.com' },
    LIST,
  )
  assert.equal(decision.block, false)
  assert.equal(decision.reason, 'not-listed')
})

interface FakeDetails {
  url: string
  resourceType: string
  frame?: { url: string } | null
}

function fakeSession(): { session: Session; fire: (details: FakeDetails) => boolean } {
  let listener: ((details: FakeDetails, callback: (r: { cancel: boolean }) => void) => void) | null = null
  const session = {
    webRequest: {
      onBeforeRequest: (
        _filter: unknown,
        callback: (details: FakeDetails, cb: (r: { cancel: boolean }) => void) => void,
      ) => {
        listener = callback
      },
    },
  } as unknown as Session
  return {
    session,
    fire: (details: FakeDetails): boolean => {
      let cancelled = false
      if (!listener) throw new Error('no listener installed')
      listener(details, (response) => {
        cancelled = response.cancel === true
      })
      return cancelled
    },
  }
}

test('install wires a session once and refuses to replace the listener', () => {
  const blocker = new Adblocker(parseBlocklist('adnxs.com\n'))
  const { session } = fakeSession()
  assert.equal(blocker.install(session), true)
  assert.equal(blocker.install(session), false, 'a second tile on the same partition must not re-register')
  assert.equal(blocker.stats().instances, 1)
})

test('a session with no list to enforce is not counted as wired', () => {
  const blocker = new Adblocker(parseBlocklist('# nothing\n'))
  const { session } = fakeSession()
  assert.equal(blocker.install(session), false)
  assert.equal(blocker.stats().instances, 0)
})

test('the installed listener cancels listed hosts and lets the rest through', () => {
  const blocker = new Adblocker(parseBlocklist('adnxs.com\n'))
  const { session, fire } = fakeSession()
  blocker.install(session)

  assert.equal(
    fire({ url: 'https://ib.adnxs.com/getuid', resourceType: 'image', frame: { url: 'https://theverge.com/' } }),
    true,
  )
  assert.equal(
    fire({ url: 'https://cdn.example.com/app.js', resourceType: 'script', frame: { url: 'https://theverge.com/' } }),
    false,
  )
  assert.equal(
    fire({ url: 'https://ib.adnxs.com/', resourceType: 'mainFrame' }),
    false,
    'a navigation stays allowed',
  )

  const stats = blocker.stats()
  assert.equal(stats.blocked, 1)
  assert.equal(stats.allowed, 2)
  assert.deepEqual(stats.lastBlocked, ['ib.adnxs.com'])
})

test('a frame whose URL is unreadable does not break the listener', () => {
  const blocker = new Adblocker(parseBlocklist('adnxs.com\n'))
  const { session, fire } = fakeSession()
  blocker.install(session)
  const hostile = {
    url: 'https://ib.adnxs.com/x',
    resourceType: 'image',
    get frame(): { url: string } {
      throw new Error('frame is gone')
    },
  }
  assert.equal(fire(hostile as unknown as FakeDetails), true, 'still blocked, without the first-party hint')
})

test('the shipped list parses and covers the hosts measured in this app', async () => {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const dir = join(import.meta.dirname, '..', 'src', 'main', 'adblock')

  const blocker = Adblocker.fromFile(Adblocker.pathIn(dir))
  assert.ok(blocker.stats().entries > 40000, `expected the full list, got ${blocker.stats().entries}`)

  const entries = parseBlocklist(await readFile(join(dir, 'blocklist.txt'), 'utf8'))
  for (const host of [
    'ib.adnxs.com',
    'js-sec.indexww.com',
    'cs.krushmedia.com',
    'tracookiepixel.xyz',
    'cdn.btloader.com',
  ]) {
    assert.equal(isBlockedHost(host, entries), true, `${host} was observed serving ads/trackers here`)
  }
  for (const host of ['github.com', 'docs.github.com', 'google.com', 'example.com']) {
    assert.equal(isBlockedHost(host, entries), false, `${host} must not be on the list`)
  }
})

test('a missing blocklist degrades to an empty list instead of throwing', (t) => {
  t.mock.method(console, 'error', () => {})
  const blocker = Adblocker.fromFile('/nonexistent/blocklist.txt')
  assert.equal(blocker.stats().entries, 0)
  const { session } = fakeSession()
  assert.equal(blocker.install(session), false)
})
