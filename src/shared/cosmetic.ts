/**
 * Cosmetic filtering: a deliberately tiny slice of the EasyList cosmetic syntax,
 * compiled to the stylesheet that hides a page's ad containers.
 *
 * Three rules, and nothing else:
 *
 *     ##selector            hide it on every page
 *     host##selector        hide it on that host and its subdomains
 *     host#@#selector       never hide it there, even if a generic rule says so
 *
 * A line starting with `!` is a comment. Anything else is ignored rather than
 * guessed at, because a filter language that half-works is one whose mistakes are
 * invisible.
 *
 * Hiding, never removing: this compiles to CSS that a page can be given, so a
 * mis-aimed rule costs a blank gap instead of a broken script, and nothing in
 * someone else's DOM is deleted.
 */

export interface CosmeticRules {
  /** Selectors hidden on every page. */
  readonly generic: readonly string[]
  /** Host suffix (lowercase, no leading dot) -> selectors hidden there. */
  readonly byHost: ReadonlyMap<string, readonly string[]>
  /** Host suffix -> selectors that must never be hidden there. */
  readonly exceptions: ReadonlyMap<string, ReadonlySet<string>>
}

/** Enough for any sane page, few enough that one bad rule cannot flood a document. */
export const MAX_COSMETIC_SELECTORS = 200

/** A ceiling on the string handed to `insertCSS`, independent of the selector cap. */
export const MAX_COSMETIC_CSS_BYTES = 24_000

/**
 * Selector-shaped characters only. `{`, `}`, `;` and `<` are absent on purpose: a
 * selector is interpolated into a stylesheet that runs inside someone else's page,
 * so a value that could close the block and open another is *refused*, not escaped.
 * Backslash is out too — it would make `\{` a legal selector character and turn the
 * whole rule into a puzzle about CSS escaping.
 */
const SELECTOR_OK = /^[A-Za-z0-9\s._#\-\[\]="'():>+~*,^$|%]+$/

const MAX_SELECTOR_LENGTH = 200

export function isSafeSelector(selector: string): boolean {
  if (typeof selector !== 'string') return false
  const trimmed = selector.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_SELECTOR_LENGTH) return false
  return SELECTOR_OK.test(trimmed)
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\.+/, '').replace(/\.$/, '')
}

/** Every dot-delimited suffix of a host, longest first: `a.b.com` -> a.b.com, b.com, com. */
function suffixes(host: string): string[] {
  const labels = host.split('.')
  const out: string[] = []
  for (let index = 0; index < labels.length; index += 1) {
    const suffix = labels.slice(index).join('.')
    if (suffix.length > 0) out.push(suffix)
  }
  return out
}

interface MutableRules {
  generic: string[]
  byHost: Map<string, string[]>
  exceptions: Map<string, Set<string>>
}

export function parseCosmeticList(text: string): CosmeticRules {
  const rules: MutableRules = { generic: [], byHost: new Map(), exceptions: new Map() }
  if (typeof text !== 'string') {
    return { generic: [], byHost: new Map(), exceptions: new Map() }
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('!')) continue
    // `#` is the prefix this list's own header uses, and a legend line such as
    // `#   host##selector` contains a separator without being a rule: parsing it filed a
    // host named `#   host`, and the startup line reported three host rule sets for a
    // list that has one. Only `##` can begin a rule, so a single `#` is a comment.
    if (line.startsWith('#') && !line.startsWith('##')) continue

    const exceptionAt = line.indexOf('#@#')
    if (exceptionAt >= 0) {
      const host = normalizeHost(line.slice(0, exceptionAt))
      const selector = line.slice(exceptionAt + 3).trim()
      // A host-less exception has nothing to scope it to, so it is meaningless here.
      if (host.length === 0 || !isSafeSelector(selector)) continue
      const bucket = rules.exceptions.get(host) ?? new Set<string>()
      bucket.add(selector)
      rules.exceptions.set(host, bucket)
      continue
    }

    const splitAt = line.indexOf('##')
    if (splitAt < 0) continue
    const host = normalizeHost(line.slice(0, splitAt))
    const selector = line.slice(splitAt + 2).trim()
    if (!isSafeSelector(selector)) continue
    if (host.length === 0) {
      if (rules.generic.length < MAX_COSMETIC_SELECTORS) rules.generic.push(selector)
      continue
    }
    const bucket = rules.byHost.get(host) ?? []
    if (bucket.length < MAX_COSMETIC_SELECTORS) bucket.push(selector)
    rules.byHost.set(host, bucket)
  }

  return { generic: rules.generic, byHost: rules.byHost, exceptions: rules.exceptions }
}

/**
 * The selectors to hide on this host: generic rules first, then the ones for the
 * host and each of its parents, minus every exception that applies. Order is kept so
 * a rule list reads top-down in the generated stylesheet.
 */
export function cosmeticSelectorsFor(rules: CosmeticRules, host: string): string[] {
  const normalized = normalizeHost(typeof host === 'string' ? host : '')
  const wanted: string[] = []
  const seen = new Set<string>()
  const add = (selector: string): void => {
    if (seen.has(selector) || wanted.length >= MAX_COSMETIC_SELECTORS) return
    seen.add(selector)
    wanted.push(selector)
  }

  for (const selector of rules.generic) add(selector)
  if (normalized.length > 0) {
    // Longest suffix first, so a site rule is never shadowed by a broader one.
    for (const suffix of suffixes(normalized)) {
      for (const selector of rules.byHost.get(suffix) ?? []) add(selector)
    }
  }

  if (normalized.length === 0) return wanted

  const excepted = new Set<string>()
  for (const suffix of suffixes(normalized)) {
    for (const selector of rules.exceptions.get(suffix) ?? []) excepted.add(selector)
  }
  return excepted.size === 0 ? wanted : wanted.filter((selector) => !excepted.has(selector))
}

export function hasCosmeticRules(rules: CosmeticRules, host: string): boolean {
  return cosmeticSelectorsFor(rules, host).length > 0
}

/**
 * The stylesheet for a set of selectors, or `''` when there is nothing to hide.
 *
 * Each selector is its own rule rather than one comma-joined list: a single invalid
 * selector invalidates the whole list in CSS, so one bad entry would silently switch
 * every rule off instead of just itself.
 */
export function cosmeticCss(selectors: readonly string[]): string {
  const safe = selectors.filter(isSafeSelector)
  if (safe.length === 0) return ''
  const body = safe
    .slice(0, MAX_COSMETIC_SELECTORS)
    .map((selector) => `${selector} { display: none !important; }\n`)
    .join('')
  // Over the ceiling the honest answer is to inject nothing: a truncated stylesheet
  // would hide some of what the list asked for and give no sign it had been clipped.
  return body.length > MAX_COSMETIC_CSS_BYTES ? '' : body
}
