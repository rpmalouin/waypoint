/**
 * Where Waypoint keeps its state, and how it takes over a `canvas-browser` installation's.
 *
 * Three paths move with the rename, and they are not the same kind of thing:
 *
 * - the config root (`~/.config/waypoint`) holds workspaces, `session.json`, `bookmarks.json` and
 *   clips — small text files this app owns;
 * - the Chromium profile (`~/Library/Application Support/waypoint`) holds cookies, the partition
 *   jars and caches — big, and written by a live Chromium;
 * - both are renamed, not copied, so exactly one tree is live afterwards. A copy would leave two
 *   divergence-prone worlds the moment either build writes again.
 *
 * The rename happens once, at startup, before the single-instance lock is taken — that lock
 * creates the user-data directory, so taking it first would leave an empty `waypoint/` in the way
 * of the profile that is about to move.
 *
 * Every failure mode is reported rather than guessed at: a profile that cannot move is left alone
 * and the app starts with a fresh one (cookies come back by logging in), while the config tree has
 * a copy fallback (`cp` then park the old tree) because losing a user's workspaces to a cross-volume
 * rename is not a failure this should ever produce.
 *
 * Pure `node:fs` + `node:os` on purpose: no Electron import, so the unit tests own the migration
 * logic instead of a smoke run that would have to boot a real app.
 */

import { cpSync, existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The name this app is installed as, and the slug every default path is built from. */
export const APP_SLUG = 'waypoint'
export const DISPLAY_NAME = 'Waypoint'
export const BUNDLE_ID = 'com.local.waypoint'
/** The name it was installed as before the rebrand. Read, never written. */
export const LEGACY_SLUG = 'canvas-browser'

export type EnvLike = { readonly [key: string]: string | undefined }

/**
 * Environment variables, new name first and the pre-rename name second.
 *
 * The legacy names stay honoured in code on purpose: the nightly LaunchAgent, a shell alias or a
 * hand-run script can still be exporting `CANVAS_CONFIG_DIR`, and a variable that silently stopped
 * being read would point the app at a different tree rather than fail. `WAYPOINT_*` always wins.
 */
export const CONFIG_DIR_ENV = ['WAYPOINT_CONFIG_DIR', 'CANVAS_CONFIG_DIR'] as const
export const CLIP_DIR_ENV = ['WAYPOINT_CLIP_DIR', 'CANVAS_CLIP_DIR'] as const
export const SMOKE_ENV = ['WAYPOINT_SMOKE', 'CANVAS_SMOKE'] as const
export const SMOKE_NET_ENV = ['WAYPOINT_SMOKE_NET', 'CANVAS_SMOKE_NET'] as const
export const APP_DEST_ENV = ['WAYPOINT_APP_DEST', 'CANVAS_APP_DEST'] as const

/**
 * A caller that names a profile (`--user-data-dir <path>`) has made the decision already.
 *
 * This matters more than it looks: `app.setPath('userData', …)` is honoured over that switch, so
 * pinning unconditionally silently redirected every isolated run into the real profile — measured
 * 2026-11-02, the smoke suite's fixture partitions (`smoke-work`, `smoke-clear`, `smoke-dark`) landed
 * in `~/Library/Application Support/waypoint` while its config dir was safely in a temp dir. The
 * switch wins, always; the pin is only for the default case.
 */
export function userDataWasNamed(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))
}

/** First defined, non-empty value among `names`. An empty string is "not set", not a path. */
export function firstEnv(env: EnvLike, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

/** Which variable decided the config root, for one honest log line instead of a guess. */
export function configDirSource(env: EnvLike = process.env): string {
  if ((env.WAYPOINT_CONFIG_DIR ?? '').length > 0) return 'WAYPOINT_CONFIG_DIR'
  if ((env.CANVAS_CONFIG_DIR ?? '').length > 0) return 'CANVAS_CONFIG_DIR (legacy name)'
  return 'default'
}

export function resolveConfigRoot(env: EnvLike = process.env, home = homedir()): string {
  return firstEnv(env, CONFIG_DIR_ENV) ?? join(home, '.config', APP_SLUG)
}

export function legacyConfigRoot(home = homedir()): string {
  return join(home, '.config', LEGACY_SLUG)
}

export type AdoptResult =
  | { status: 'moved'; from: string; to: string; how: 'rename' | 'copy' }
  | { status: 'kept'; to: string }
  | { status: 'absent'; from: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; from: string; to: string; error: string }

/**
 * Written into the Chromium profile on every launch that did not skip storage work.
 *
 * It exists because "is the target directory empty" is the wrong question: Electron creates and
 * populates `~/Library/Application Support/<slug>/` with GPU caches before any of this code runs,
 * so a brand-new profile and a used one look alike on the first launch. The marker is the only
 * reliable statement that this directory has already been through the adoption decision.
 */
export const PROFILE_MARKER = '.waypoint-state.json'

function pathExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** An empty directory is what Chromium pre-creates; it is not state to preserve. */
function isEmptyDir(path: string): boolean {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length === 0
  } catch {
    return false
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The two filesystem moves `adoptDirectory` performs. Injectable so the unit tests can exercise the
 * cross-volume path (a real `rename` only fails across devices, which no test can arrange cheaply)
 * without the production code growing a second branch.
 */
export interface AdoptOps {
  rename?: (from: string, to: string) => void
  copy?: (from: string, to: string) => void
}

export interface AdoptOptions {
  copyFallback?: boolean
  ops?: AdoptOps
  /**
   * Asked only when the target already has content: `true` means "this is bootstrap noise, not
   * state, replace it". The bootstrapped directory is parked as `<to>.pre-migration-<stamp>`
   * rather than deleted, so a wrong answer leaves evidence instead of a hole.
   */
  replaceTarget?: (to: string) => boolean
}

/**
 * Move `from` onto `to`, once.
 *
 * - nothing at `from` → `absent`, which is the normal first run of a fresh install;
 * - something at `to` → `kept`, unless `replaceTarget` says it is not real state;
 * - an *empty* `to` is removed first, because Electron creates the user-data directory at startup;
 * - `copyFallback` is for the config tree only. It copies, then parks the source as
 *   `<from>.pre-waypoint` so the old tree cannot be written twice; a partial copy is removed so a
 *   half-migrated config can never look like a complete one.
 */
export function adoptDirectory(
  from: string,
  to: string,
  opts: AdoptOptions = {},
): AdoptResult {
  const rename = opts.ops?.rename ?? renameSync
  const copy = opts.ops?.copy ?? ((source: string, target: string) => cpSync(source, target, { recursive: true }))
  if (!pathExists(from)) return { status: 'absent', from }
  if (pathExists(to) && !isEmptyDir(to)) {
    if (!(opts.replaceTarget?.(to) ?? false)) return { status: 'kept', to }
    renameSync(to, `${to}.pre-migration-${Date.now()}`)
  }
  if (pathExists(to)) rmSync(to, { recursive: true, force: true })

  try {
    rename(from, to)
    return { status: 'moved', from, to, how: 'rename' }
  } catch (error) {
    if (!opts.copyFallback) return { status: 'failed', from, to, error: message(error) }
    try {
      copy(from, to)
      const parked = pathExists(`${from}.pre-${APP_SLUG}`)
        ? `${from}.pre-${APP_SLUG}-${Date.now()}`
        : `${from}.pre-${APP_SLUG}`
      renameSync(from, parked)
      return { status: 'moved', from, to, how: 'copy' }
    } catch (copyError) {
      rmSync(to, { recursive: true, force: true })
      return { status: 'failed', from, to, error: message(copyError) }
    }
  }
}

export function legacyProfileRoot(appDataDir: string): string {
  return join(appDataDir, LEGACY_SLUG)
}

/** True while a build of the old app is running against the old profile. */
export function legacyProfileIsLive(appDataDir: string): boolean {
  return pathExists(join(legacyProfileRoot(appDataDir), 'SingletonLock'))
}

export interface StoragePlan {
  configRoot: string
  config: AdoptResult
  profile: AdoptResult
}

export interface StorageOptions {
  env?: EnvLike
  argv?: readonly string[]
  home?: string
  appDataDir: string
  userDataDir: string
}

function isSmokeRun(env: EnvLike, argv: readonly string[]): boolean {
  return firstEnv(env, SMOKE_ENV) === '1' || argv.includes('--smoke')
}

/**
 * Take over the previous installation's state, or explain why it was left alone.
 *
 * The skips are the safety property, not politeness:
 *
 * - a smoke run must not touch a real profile, ever (that is the failure the packaging skill's
 *   rule 16 exists for);
 * - `--user-data-dir` means the caller chose an isolated profile — that is a probe, not a migration;
 * - an explicit `WAYPOINT_CONFIG_DIR`/`CANVAS_CONFIG_DIR` names the tree the caller wants, so the
 *   default tree is none of this run's business;
 * - a live legacy profile means the old build is open. Renaming its profile would corrupt a running
 *   Chromium, and renaming the config tree would split the state it is still writing.
 */
export function migrateLegacyStorage(opts: StorageOptions): StoragePlan {
  const env = opts.env ?? process.env
  const argv = opts.argv ?? process.argv
  const home = opts.home ?? homedir()
  const configRoot = resolveConfigRoot(env, home)
  const profileTo = opts.userDataDir
  const profileFrom = legacyProfileRoot(opts.appDataDir)

  const skip = (reason: string): StoragePlan => ({
    configRoot,
    config: { status: 'skipped', reason },
    profile: { status: 'skipped', reason },
  })

  if (isSmokeRun(env, argv)) return skip('smoke run')
  if (userDataWasNamed(argv)) return skip('--user-data-dir run')
  if (configDirSource(env) !== 'default') return skip('config root set by the environment')
  if (legacyProfileIsLive(opts.appDataDir)) return skip(`the ${LEGACY_SLUG} build is running`)

  // Config first: it is the small tree, and a failure there leaves the profile untouched rather
  // than half-moving a 200 MB profile behind a config that could not follow.
  const config = adoptDirectory(legacyConfigRoot(home), configRoot, { copyFallback: true })
  const profile = adoptDirectory(profileFrom, profileTo, {
    // A target with no marker has never completed this decision, so whatever is in it was written
    // by this launch's own Chromium bootstrap (GPU caches, a SingletonLock) and is not state.
    replaceTarget: (to) => !pathExists(join(to, PROFILE_MARKER)),
  })
  stampProfile(profileTo, profile)

  return { configRoot, config, profile }
}

/**
 * Record the decision in the profile. Nothing else in the app reads it — it exists so the *next*
 * launch can tell a profile that has been through adoption from one this launch just bootstrapped.
 */
function stampProfile(userDataDir: string, result: AdoptResult): void {
  if (result.status === 'skipped' || result.status === 'failed') return
  if (!pathExists(userDataDir)) return
  try {
    writeFileSync(
      join(userDataDir, PROFILE_MARKER),
      `${JSON.stringify({ app: APP_SLUG, adoption: result.status, at: new Date().toISOString() })}\n`,
    )
  } catch (error) {
    console.error(`[storage] could not write ${PROFILE_MARKER}:`, error)
  }
}

/** One line per outcome, because a silent migration and a silent failure look identical later. */
export function describeAdopt(label: string, result: AdoptResult): string | null {
  switch (result.status) {
    case 'moved':
      return `[storage] ${label}: moved ${result.from} -> ${result.to} (${result.how})`
    case 'kept':
      return `[storage] ${label}: ${result.to} already holds state; nothing migrated`
    case 'absent':
      return null
    case 'skipped':
      return `[storage] ${label}: migration skipped (${result.reason})`
    case 'failed':
      return `[storage] ${label}: could not move ${result.from} -> ${result.to}: ${result.error}`
  }
}
