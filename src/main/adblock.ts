import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OnBeforeRequestListenerDetails, Session } from 'electron'
import { decideRequest, hostOf, parseBlocklist } from '../shared/adblock.ts'

/**
 * Per-session ad and tracker blocking.
 *
 * Why this lives here and not in `sessions.ts`: that module is deliberately free
 * of any `electron` *value* import so its cookie-flush budget can be unit-tested
 * against fake stores. Blocking needs the real `Session` type and a real
 * `webRequest`, so it gets its own module and an instance the app owns. Both are
 * applied at the same choke point — `TileRegistry.create` and app startup — so a
 * new partition cannot be born unblocked.
 *
 * The instance (not module globals) exists so tests can build one from a
 * two-line list and assert on its own counters.
 */

export interface BlockerStats {
  /** Hostnames in the loaded list. */
  entries: number
  /** Time spent reading and parsing the list, in ms. */
  loadMs: number
  /** Sessions this instance has wired. */
  instances: number
  allowed: number
  blocked: number
  /** Most recent blocked hosts, oldest first, capped for display. */
  lastBlocked: string[]
}

const MAX_LAST_BLOCKED = 20

export class Adblocker {
  /**
   * Fields are declared, not constructor parameter properties: `npm test` runs
   * Node's strip-only TypeScript mode, which rejects `constructor(private x)`
   * outright. Any module a test imports has to hold to that.
   */
  private readonly entries: ReadonlySet<string>
  readonly loadMs: number
  private readonly installed = new WeakSet<Session>()
  private allowed = 0
  private blocked = 0
  private instances = 0
  private lastBlocked: string[] = []

  constructor(entries: ReadonlySet<string>, loadMs = 0) {
    this.entries = entries
    this.loadMs = loadMs
  }

  /**
   * Read and parse the bundled list. A missing or unreadable file is logged and
   * becomes an empty list — the app must still start, and `stats().entries`
   * makes the failure visible instead of silently pretending to block.
   */
  static fromFile(path: string): Adblocker {
    const startedAt = Date.now()
    try {
      const entries = parseBlocklist(readFileSync(path, 'utf8'))
      return new Adblocker(entries, Date.now() - startedAt)
    } catch (error) {
      console.error('[adblock] could not read the blocklist:', error)
      return new Adblocker(new Set(), Date.now() - startedAt)
    }
  }

  static pathIn(directory: string): string {
    return join(directory, 'blocklist.txt')
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * Wire one session. Returns false when it was already wired (a second tile on
   * the same partition) or when there is nothing to enforce: `webRequest`
   * handlers are per-session singletons, so registering twice would silently
   * replace the first listener instead of stacking.
   */
  install(ses: Session): boolean {
    if (this.installed.has(ses)) return false
    this.installed.add(ses)
    if (this.entries.size === 0) return false

    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      const decision = decideRequest(
        {
          url: details.url,
          firstPartyHost: frameHost(details),
          isMainFrame: details.resourceType === 'mainFrame',
        },
        this.entries,
      )
      if (!decision.block) {
        this.allowed += 1
        callback({ cancel: false })
        return
      }
      this.blocked += 1
      if (decision.host) {
        this.lastBlocked.push(decision.host)
        if (this.lastBlocked.length > MAX_LAST_BLOCKED) this.lastBlocked.shift()
      }
      callback({ cancel: true })
    })

    this.instances += 1
    return true
  }

  stats(): BlockerStats {
    return {
      entries: this.entries.size,
      loadMs: this.loadMs,
      instances: this.instances,
      allowed: this.allowed,
      blocked: this.blocked,
      lastBlocked: [...this.lastBlocked],
    }
  }
}

/** Host of the frame that issued the request; a destroyed frame throws on access. */
function frameHost(details: OnBeforeRequestListenerDetails): string | null {
  try {
    const url = details.frame?.url
    return url ? hostOf(url) : null
  } catch {
    return null
  }
}
