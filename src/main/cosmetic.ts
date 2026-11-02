/**
 * Cosmetic filtering, main-process side: the parsed rules plus the set of hosts the
 * user has paused.
 *
 * This module deliberately imports nothing from `electron`. It reads a file and
 * answers "what CSS does this URL get?", which makes it testable and keeps the
 * `webContents` work in `registry.ts`, where the navigation events already live.
 *
 * The pause set is held here and persisted by the caller: a host the user turned off
 * has to stay off across launches, or the fix is undone by the next restart.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostOf } from '../shared/adblock.ts'
import {
  MAX_COSMETIC_SELECTORS,
  cosmeticCss,
  cosmeticSelectorsFor,
  hasCosmeticRules,
  parseCosmeticList,
} from '../shared/cosmetic.ts'
import type { CosmeticRules } from '../shared/cosmetic.ts'

const MAX_PAUSED_HOSTS = 200

export interface CosmeticStats {
  /** Generic selectors in the list. */
  generic: number
  /** Host suffixes that carry their own selectors. */
  hosts: number
  /** Hosts the user has paused. */
  paused: number
}

export class CosmeticFilter {
  private readonly rules: CosmeticRules
  private readonly paused = new Set<string>()

  constructor(rules: CosmeticRules) {
    this.rules = rules
  }

  /**
   * A missing or unreadable list is logged and becomes an empty rule set: the app
   * must still start, and `stats()` shows the failure rather than a page that is
   * quietly unfiltered for reasons nobody can see.
   */
  static fromFile(path: string): CosmeticFilter {
    try {
      return new CosmeticFilter(parseCosmeticList(readFileSync(path, 'utf8')))
    } catch (error) {
      console.error('[cosmetic] could not read the rule list:', error)
      return new CosmeticFilter(parseCosmeticList(''))
    }
  }

  static pathIn(directory: string): string {
    return join(directory, 'cosmetic.txt')
  }

  private static normalize(host: unknown): string {
    return typeof host === 'string' ? host.toLowerCase().replace(/^\.+/, '').replace(/\.$/, '') : ''
  }

  isPaused(host: string): boolean {
    return this.paused.has(CosmeticFilter.normalize(host))
  }

  /** Returns true when the state actually changed, so a repeat press is a no-op. */
  setPaused(host: string, paused: boolean): boolean {
    const normalized = CosmeticFilter.normalize(host)
    if (normalized.length === 0) return false
    if (paused) {
      if (this.paused.has(normalized) || this.paused.size >= MAX_PAUSED_HOSTS) return false
      this.paused.add(normalized)
      return true
    }
    return this.paused.delete(normalized)
  }

  pausedHosts(): string[] {
    return [...this.paused].sort()
  }

  /** Load the persisted pause set; anything that is not a hostname is dropped. */
  loadPaused(hosts: unknown): void {
    this.paused.clear()
    if (!Array.isArray(hosts)) return
    for (const host of hosts.slice(0, MAX_PAUSED_HOSTS)) {
      const normalized = CosmeticFilter.normalize(host)
      if (normalized.length > 0) this.paused.add(normalized)
    }
  }

  /** Whether this page's host has any rule at all — what the chrome's shield shows. */
  hasRules(url: string): boolean {
    return hasCosmeticRules(this.rules, hostOf(url) ?? '')
  }

  /**
   * The stylesheet for this URL, or `''` for nothing to do.
   *
   * A paused host answers empty, which is the same answer a host with no rules gives:
   * both mean "do not touch this document", and the caller has no reason to tell them
   * apart when injecting.
   */
  cssFor(url: string): string {
    const host = hostOf(url) ?? ''
    if (host.length > 0 && this.isPaused(host)) return ''
    const selectors = cosmeticSelectorsFor(this.rules, host)
    if (selectors.length === 0) return ''
    return cosmeticCss(selectors.slice(0, MAX_COSMETIC_SELECTORS))
  }

  stats(): CosmeticStats {
    let hosts = 0
    for (const selectors of this.rules.byHost.values()) hosts += selectors.length > 0 ? 1 : 0
    return { generic: this.rules.generic.length, hosts, paused: this.paused.size }
  }
}
