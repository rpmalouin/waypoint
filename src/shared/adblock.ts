/**
 * Ad and tracker blocking: the decision, with no Electron in sight.
 *
 * The list is a set of bare hostnames, so matching is a suffix walk — a request
 * host is blocked when it *is* an entry or ends with `.<entry>`. That is what
 * makes `ib.adnxs.com` match an `adnxs.com` entry without any wildcard syntax,
 * and it is also why the shipped list drops every host whose parent is already
 * listed: the parent already covers it.
 *
 * Three things are deliberately allowed and must stay that way:
 *
 * - **Top-level navigations.** If the user typed the address, blocking it turns
 *   a typo into a broken app. The list never overrides an explicit navigation.
 * - **Non-HTTP(S) requests.** `file:`, `data:`, `about:`, `blob:` and the app's
 *   own pages have no hostname to match, and blocking them would break the UI.
 * - **Same-site requests.** A request from a document to itself (or to a
 *   subdomain of itself) is first-party, not tracking.
 *
 * Same-site is host-suffix comparison, not eTLD+1: doing it properly needs a
 * public-suffix list, and this app has no runtime dependencies. The consequence
 * is documented — `a.example.co.uk` and `b.example.co.uk` are treated as
 * unrelated. That errs towards *blocking* only when one of those hosts is
 * already on a blocklist, which is the direction that costs nothing.
 */

/** What the blocker needs to know about one request. */
export interface RequestFacts {
  url: string
  /** Host of the document that issued the request, when the caller knows it. */
  firstPartyHost?: string | null
  /** A top-level navigation: the user asked for this URL. */
  isMainFrame?: boolean
}

export type BlockReason = 'main-frame' | 'not-http' | 'same-site' | 'not-listed' | 'listed'

export interface RequestDecision {
  block: boolean
  reason: BlockReason
  /** Host that was matched, for logs and assertions; null when nothing matched. */
  host: string | null
}

const HOSTNAME_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/
const IPV4_RE = /^\d+\.\d+\.\d+\.\d+$/
const MAX_HOST_LENGTH = 253

/**
 * Hostname from an absolute http(s) URL, lowercased, without port or trailing
 * dot. Null for every other scheme — the caller treats that as "not ours to
 * judge".
 */
export function hostOf(url: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  return host.length > 0 && host.length <= MAX_HOST_LENGTH ? host : null
}

/**
 * Parse the shipped blocklist. Tolerant by design: comments, blank lines, a
 * leading `*.` (some upstream lists use it) and junk are skipped rather than
 * throwing, because a malformed line must not stop the app from starting.
 */
export function parseBlocklist(text: string): Set<string> {
  const entries = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const host = line.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
    if (host.length === 0 || host.length > MAX_HOST_LENGTH) continue
    if (!HOSTNAME_RE.test(host) && !IPV4_RE.test(host)) continue
    entries.add(host)
  }
  return entries
}

/** True when `host` is on the list, or is a subdomain of something on it. */
export function isBlockedHost(host: string, entries: ReadonlySet<string>): boolean {
  if (typeof host !== 'string') return false
  const normalized = host.toLowerCase().replace(/\.$/, '')
  if (normalized.length === 0) return false
  // An IP literal has no parent domains to walk; only an exact entry counts.
  if (IPV4_RE.test(normalized)) return entries.has(normalized)
  const labels = normalized.split('.')
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (entries.has(labels.slice(index).join('.'))) return true
  }
  return false
}

/**
 * Whether two hosts belong to the same site for first-party purposes. Suffix
 * based (`www.example.com` and `cdn.example.com` are *not* the same site, but
 * `cdn.example.com` and `example.com` are), which is the conservative reading:
 * anything it declines to call same-site still has to be on the list to be
 * blocked.
 */
export function sameSite(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false
  const left = a.toLowerCase().replace(/\.$/, '')
  const right = b.toLowerCase().replace(/\.$/, '')
  if (left === right) return true
  return left.endsWith(`.${right}`) || right.endsWith(`.${left}`)
}

/** The whole policy in one place, so the listener in main stays mechanical. */
export function decideRequest(facts: RequestFacts, entries: ReadonlySet<string>): RequestDecision {
  if (facts.isMainFrame === true) return { block: false, reason: 'main-frame', host: null }
  const host = hostOf(facts.url)
  if (host === null) return { block: false, reason: 'not-http', host: null }
  if (facts.firstPartyHost && sameSite(facts.firstPartyHost, host)) {
    return { block: false, reason: 'same-site', host }
  }
  if (isBlockedHost(host, entries)) return { block: true, reason: 'listed', host }
  return { block: false, reason: 'not-listed', host }
}
