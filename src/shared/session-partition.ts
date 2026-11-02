/**
 * Tile session partitions.
 *
 * A partition string is a storage key, not a label: Chromium maps
 * `persist:<name>` onto a directory under the user-data dir, so anything that
 * reaches `webPreferences.partition` is validated here the same way a workspace
 * name is validated before it reaches the filesystem.
 *
 * The vocabulary, in one place:
 *
 * - `DEFAULT_TILE_PARTITION` — every tile that does not ask for something else.
 *   Shared on purpose: sign into Google, GitHub or Gemini once and the next tile
 *   is already signed in. Cookies, localStorage, IndexedDB and service workers
 *   all live in this one jar.
 * - `persist:<name>` — a named persistent container, for work that must not see
 *   the default session's cookies (a second account, a client's tenant).
 * - `temp:<name>` or a bare `<name>` — Electron's spelling for an *in-memory*
 *   partition (anything without the `persist:` prefix). Nothing is written to
 *   disk, so those cookies vanish when the app quits. This is the "private tile"
 *   case, and it is the reason the prefix is optional rather than forbidden.
 */

export const DEFAULT_TILE_PARTITION = 'persist:main'

const PERSIST_PREFIX = 'persist:'
const TEMP_PREFIX = 'temp:'

/**
 * The name after an optional `persist:`/`temp:` prefix. Deliberately narrower
 * than Chromium's own rules: no dots, slashes or whitespace, so no partition can
 * escape the `Partitions/` directory or collide with a path segment. Only
 * `persist:` names ever reach the disk, which is why only they are flushed.
 */
const PERSIST_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
const MEMORY_NAME_RE = /^(?:temp:)?[A-Za-z0-9_-]{1,64}$/

export function isTilePartition(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.startsWith(PERSIST_PREFIX)) return PERSIST_NAME_RE.test(value.slice(PERSIST_PREFIX.length))
  return MEMORY_NAME_RE.test(value)
}

/**
 * Anything unusable becomes the default session rather than an exception: a
 * hand-edited workspace with a broken partition should open the tile in the
 * shared jar, not fail the load or invent a storage directory from junk.
 */
export function normalizeTilePartition(value: unknown): string {
  return isTilePartition(value) ? value : DEFAULT_TILE_PARTITION
}

/**
 * Only a `persist:` partition has cookies on disk to flush. An in-memory
 * partition has no store, so flushing one is a no-op at best and an error at
 * worst.
 */
export function isPersistentPartition(partition: string): boolean {
  return partition.startsWith(PERSIST_PREFIX)
}

// ---------------------------------------------------------------- omnibox syntax

/**
 * `@name target` — the prefix form. The name may not contain whitespace, so the
 * first word after the `@` is always the container and the rest is the target.
 */
const AT_FORM_RE = /^@([^\s]*)(?:\s+([\s\S]*))?$/

/** `name:target` — the colon form. The target cannot start with whitespace. */
const COLON_FORM_RE = /^([A-Za-z0-9_-]{1,64}):(\S.*)$/

/** `<persist|temp>:name target` — the canonical spelling, accepted verbatim. */
const CANONICAL_FORM_RE = /^(persist|temp):([A-Za-z0-9_-]{1,64})\s+(\S.*)$/

/** A target with an authority component; never a container name. */
const AUTHORITY_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i

/** Schemes that are real navigations even though they carry no `//`. */
const OPAQUE_SCHEME_RE = /^(?:about|data|file|view-source|blob|mailto|javascript|chrome|chrome-extension):/i

/**
 * Leading tokens that look like a container under the colon form but are
 * schemes or hostnames in the wild: `https:…`, `mailto:…`.
 */
const SCHEME_TOKENS = new Set([
  'http',
  'https',
  'file',
  'about',
  'data',
  'view-source',
  'blob',
  'mailto',
  'javascript',
  'chrome',
  'chrome-extension',
  'ftp',
  'ftps',
  'ws',
  'wss',
])

/** Generated in-memory container names, collapsed to a `temp` badge. */
const GENERATED_TEMP_RE = /^anon-[0-9a-z]{4,16}$/

export interface OmniboxTarget {
  /** What to navigate to, with any container prefix removed. Not a URL yet. */
  target: string
  /** Validated partition for the new tile; the shared jar when nothing matched. */
  partition: string
}

function defaultTempSuffix(): string {
  // Not a store key on disk (nothing is persisted for a `temp:` partition), so a
  // cheap RNG is enough: it only has to keep two `@temp` tiles in separate jars.
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0')
}

/**
 * A colon form needs a target that reads as an address. Without this,
 * `localhost:3000` would become a container called `localhost` holding an item
 * called `3000`, and a bare port typed after a host would silently become one.
 */
function looksLikeTarget(rest: string): boolean {
  if (rest === '') return false
  if (/^\d/.test(rest)) return false // `localhost:3000` is a host and a port.
  return AUTHORITY_URL_RE.test(rest) || /[./]/.test(rest)
}

function resolveContainer(
  name: string,
  rest: string,
  whole: string,
  makeSuffix: () => string,
): OmniboxTarget {
  if (name.toLowerCase() === 'temp') {
    // `@temp` names no jar on purpose: every one gets a fresh in-memory store,
    // which is what a private tile means. The generated name is still written to
    // the workspace, so a reload keeps the badge and the (empty) jar identity.
    return { target: rest, partition: `${TEMP_PREFIX}anon-${makeSuffix()}` }
  }
  if (!PERSIST_NAME_RE.test(name)) {
    // Hostile or malformed (`@../../etc`, a 65-character name): the container is
    // refused, but the address the user typed is still what they asked for.
    return { target: rest || whole, partition: DEFAULT_TILE_PARTITION }
  }
  return { target: rest, partition: `${PERSIST_PREFIX}${name}` }
}

/**
 * Splits omnibox input into a container and a target.
 *
 * Accepted spellings, all equivalent:
 *
 *     @work https://github.com      @temp https://example.com
 *     work:https://github.com       temp:https://example.com
 *     persist:work https://github.com
 *
 * Anything else — a plain URL, a host, a search phrase — stays in the shared
 * jar, which is what almost every navigation wants. A URL is recognised before
 * any prefix rule, because `https://…` also has a colon in it; a colon form
 * additionally needs a target that looks like an address, because
 * `localhost:3000` is a host and a port.
 *
 * A malformed prefix never throws and never invents a storage key: the tile
 * opens in the shared jar, which is the same fallback `normalizeTilePartition`
 * applies to a hand-edited workspace.
 */
export function parseOmniboxInput(
  raw: string,
  makeSuffix: () => string = defaultTempSuffix,
): OmniboxTarget {
  const input = raw.trim()
  if (input === '') return { target: '', partition: DEFAULT_TILE_PARTITION }

  // A real URL is never a container: `https://example.com` must not become
  // `persist:https`.
  if (AUTHORITY_URL_RE.test(input) || OPAQUE_SCHEME_RE.test(input)) {
    return { target: input, partition: DEFAULT_TILE_PARTITION }
  }

  const at = AT_FORM_RE.exec(input)
  if (at) {
    const [, name = '', rest = ''] = at
    // A lone `@` is not a prefix; treat the whole input as the target.
    if (name === '') return { target: input, partition: DEFAULT_TILE_PARTITION }
    return resolveContainer(name, rest.trim(), input, makeSuffix)
  }

  const canonical = CANONICAL_FORM_RE.exec(input)
  if (canonical) {
    const [, prefix = '', name = '', rest = ''] = canonical
    const partition = `${prefix}:${name}`
    if (isTilePartition(partition)) return { target: rest.trim(), partition }
  }

  const colon = COLON_FORM_RE.exec(input)
  if (colon) {
    const [, name = '', rest = ''] = colon
    if (!SCHEME_TOKENS.has(name.toLowerCase()) && looksLikeTarget(rest)) {
      return resolveContainer(name, rest, input, makeSuffix)
    }
  }

  return { target: input, partition: DEFAULT_TILE_PARTITION }
}

/**
 * The short text a tile's container badge shows.
 *
 * Null means "no badge": the shared default jar is what almost every tile uses,
 * and badging it would put a pill on every tile for no information. A generated
 * in-memory name (`anon-1a2b3c4d`) collapses to `temp` — the useful fact is that
 * the jar dies at quit, not its random name.
 */
export function containerLabel(partition: string): string | null {
  if (partition === DEFAULT_TILE_PARTITION) return null
  if (partition.startsWith(PERSIST_PREFIX)) return partition.slice(PERSIST_PREFIX.length)
  if (partition.startsWith(TEMP_PREFIX)) {
    const name = partition.slice(TEMP_PREFIX.length)
    return GENERATED_TEMP_RE.test(name) ? 'temp' : name
  }
  // A bare name is an in-memory partition too (Electron's own spelling).
  return partition
}

// ------------------------------------------------------------ container menus

/** One row of a container menu: the jar, the name it wears, and its lifetime. */
export interface ContainerChoice {
  /** The partition string a tile must be created on to join this jar. */
  partition: string
  /** The badge text — the same label the tile chrome and sidebar draw. */
  label: string
  /** True for `persist:<name>` (survives a restart), false for in-memory jars. */
  persistent: boolean
}

/**
 * The container list a menu shows, derived from the partitions tiles are using.
 *
 * There is no registry of containers on disk: a `persist:` directory that no tile
 * is using is indistinguishable from one the user abandoned, so the live tiles
 * are the only authority. Rows are deduped by *label* rather than by partition,
 * because the label is the identity a person picks from: two `@temp` tiles are two
 * jars wearing the same name, and offering both would only let a menu claim it can
 * reopen a jar that a fresh `@temp` cannot.
 *
 * Default-jar tiles contribute nothing (there is no badge to show and no choice to
 * make), and malformed strings are skipped rather than normalised: a menu must not
 * offer a container the registry would silently replace with the shared jar.
 */
export function containerChoices(partitions: Iterable<string | undefined>): ContainerChoice[] {
  const byLabel = new Map<string, ContainerChoice>()
  for (const raw of partitions) {
    if (raw === undefined || raw === DEFAULT_TILE_PARTITION) continue
    if (!isTilePartition(raw)) continue
    const label = containerLabel(raw)
    if (label === null || byLabel.has(label)) continue
    byLabel.set(label, { partition: raw, label, persistent: isPersistentPartition(raw) })
  }
  // Persistent jars first — they are the ones worth reusing — then by name, so the
  // list cannot reorder itself between two renders of the same tiles.
  return [...byLabel.values()].sort((a, b) => {
    if (a.persistent !== b.persistent) return a.persistent ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}

/**
 * The omnibox text that opens a tile in an existing container, or null for the
 * shared jar (which needs no prefix).
 *
 * This is why the menu can be trusted: a generated `temp:anon-<hex>` name is one
 * tile's private jar, so `@temp ` is the only honest thing to offer for it — it
 * mints a *new* private jar, exactly as pressing the pill would. Returning the
 * generated name would promise a rejoin that cannot happen.
 */
export function containerPrefix(partition: string): string | null {
  if (partition === DEFAULT_TILE_PARTITION || !isTilePartition(partition)) return null
  if (isPersistentPartition(partition)) return `@${partition.slice(PERSIST_PREFIX.length)} `
  if (!partition.startsWith(TEMP_PREFIX)) {
    // A bare in-memory name is a partition string in its own right: `private` and
    // `temp:private` are two different in-memory jars, and no omnibox spelling
    // produces the bare form, so there is nothing honest to type. Such a tile can
    // still be *moved* into (a move passes the exact string); it just cannot be
    // reopened by name, which the menu shows by offering no prefix for it.
    return null
  }
  const body = partition.slice(TEMP_PREFIX.length)
  return GENERATED_TEMP_RE.test(body) ? '@temp ' : `temp:${body} `
}
