import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  APP_SLUG,
  LEGACY_SLUG,
  PROFILE_MARKER,
  adoptDirectory,
  configDirSource,
  firstEnv,
  legacyProfileIsLive,
  migrateLegacyStorage,
  resolveConfigRoot,
  userDataWasNamed,
} from '../src/main/config-root.ts'

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'waypoint-config-'))
}

/** Write `body` into `<root>/<relative>`, creating the parents. */
function seed(root: string, relative: string, body: string): void {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

function contents(root: string, relative: string): string {
  return readFileSync(join(root, relative), 'utf8')
}

// ---------------------------------------------------------------- name resolution

test('the config root takes WAYPOINT_CONFIG_DIR over the pre-rename variable', () => {
  assert.equal(
    resolveConfigRoot({ WAYPOINT_CONFIG_DIR: '/new', CANVAS_CONFIG_DIR: '/old' }, '/home/user'),
    '/new',
  )
  assert.equal(configDirSource({ WAYPOINT_CONFIG_DIR: '/new', CANVAS_CONFIG_DIR: '/old' }), 'WAYPOINT_CONFIG_DIR')
})

test('the pre-rename variable is still honoured, and reported as legacy', () => {
  assert.equal(resolveConfigRoot({ CANVAS_CONFIG_DIR: '/old' }, '/home/user'), '/old')
  assert.equal(configDirSource({ CANVAS_CONFIG_DIR: '/old' }), 'CANVAS_CONFIG_DIR (legacy name)')
})

test('with nothing set the config root is ~/.config/waypoint', () => {
  assert.equal(resolveConfigRoot({}, '/home/user'), join('/home/user', '.config', APP_SLUG))
  assert.equal(configDirSource({}), 'default')
  assert.equal(APP_SLUG, 'waypoint')
})

test('an empty variable is "not set", not an empty path', () => {
  assert.equal(firstEnv({ WAYPOINT_CONFIG_DIR: '' }, ['WAYPOINT_CONFIG_DIR', 'CANVAS_CONFIG_DIR']), undefined)
  assert.equal(
    resolveConfigRoot({ WAYPOINT_CONFIG_DIR: '', CANVAS_CONFIG_DIR: '/old' }, '/home/user'),
    '/old',
  )
})

test('a named profile is detected in both argument forms, and not invented', () => {
  assert.equal(userDataWasNamed(['electron', '.', '--user-data-dir=/tmp/probe']), true)
  assert.equal(userDataWasNamed(['electron', '.', '--user-data-dir', '/tmp/probe']), true)
  assert.equal(userDataWasNamed(['electron', '.', '--smoke']), false)
  assert.equal(userDataWasNamed([]), false)
})

// ------------------------------------------------------------------ the directory move

test('nothing to adopt is not an error', () => {
  const root = sandbox()
  try {
    const result = adoptDirectory(join(root, 'missing'), join(root, 'target'))
    assert.equal(result.status, 'absent')
    assert.equal(existsSync(join(root, 'target')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an existing tree is renamed onto the new name, and an empty target is cleared first', () => {
  const root = sandbox()
  try {
    seed(join(root, 'old'), 'workspaces/start.json', '{"tiles":[]}')
    // Electron pre-creates the user-data directory; an empty one must not block the move.
    mkdirSync(join(root, 'new'))

    const result = adoptDirectory(join(root, 'old'), join(root, 'new'))
    assert.equal(result.status, 'moved')
    assert.equal(existsSync(join(root, 'old')), false)
    assert.equal(contents(join(root, 'new'), 'workspaces/start.json'), '{"tiles":[]}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a target that already holds state is kept, and the old tree is left alone', () => {
  const root = sandbox()
  try {
    seed(join(root, 'old'), 'session.json', '{"lastWorkspace":"start"}')
    seed(join(root, 'new'), 'session.json', '{"lastWorkspace":"other"}')

    const result = adoptDirectory(join(root, 'old'), join(root, 'new'))
    assert.equal(result.status, 'kept')
    assert.equal(contents(join(root, 'new'), 'session.json'), '{"lastWorkspace":"other"}')
    assert.equal(contents(join(root, 'old'), 'session.json'), '{"lastWorkspace":"start"}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a rename that cannot cross devices falls back to a copy and parks the old tree', () => {
  const root = sandbox()
  try {
    seed(join(root, 'old'), 'workspaces/start.json', '{"tiles":[1]}')
    const crossDevice = () => {
      const error = new Error('EXDEV: cross-device link not permitted')
      throw error
    }

    const result = adoptDirectory(join(root, 'old'), join(root, 'new'), {
      copyFallback: true,
      ops: { rename: crossDevice, copy: (from, to) => cpSync(from, to, { recursive: true }) },
    })

    assert.equal(result.status, 'moved')
    assert.equal(result.status === 'moved' ? result.how : 'unknown', 'copy')
    assert.equal(contents(join(root, 'new'), 'workspaces/start.json'), '{"tiles":[1]}')
    // The source is parked, not left as a second live tree.
    assert.equal(existsSync(join(root, 'old')), false)
    assert.equal(contents(join(root, `old.pre-${APP_SLUG}`), 'workspaces/start.json'), '{"tiles":[1]}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('without the fallback a failed rename is reported and changes nothing', () => {
  const root = sandbox()
  try {
    seed(join(root, 'old'), 'session.json', '{}')
    const result = adoptDirectory(join(root, 'old'), join(root, 'new'), {
      ops: {
        rename: () => {
          throw new Error('EPERM: operation not permitted')
        },
      },
    })
    assert.equal(result.status, 'failed')
    assert.match(result.status === 'failed' ? result.error : '', /EPERM/)
    assert.equal(contents(join(root, 'old'), 'session.json'), '{}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a copy that fails leaves no half-migrated target behind', () => {
  const root = sandbox()
  try {
    seed(join(root, 'old'), 'session.json', '{}')
    const result = adoptDirectory(join(root, 'old'), join(root, 'new'), {
      copyFallback: true,
      ops: {
        rename: () => {
          throw new Error('EXDEV')
        },
        copy: (_from, to) => {
          // A partial copy: something landed, then it broke.
          mkdirSync(join(to, 'workspaces'), { recursive: true })
          throw new Error('ENOSPC: no space left on device')
        },
      },
    })
    assert.equal(result.status, 'failed')
    assert.equal(existsSync(join(root, 'new')), false)
    // The source is still the only copy, untouched.
    assert.equal(contents(join(root, 'old'), 'session.json'), '{}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------- the startup decision

function installFixture(): { home: string; appData: string; root: string } {
  const root = sandbox()
  const home = join(root, 'home')
  const appData = join(root, 'appData')
  seed(home, `.config/${LEGACY_SLUG}/workspaces/start.json`, '{"tiles":[]}')
  seed(home, `.config/${LEGACY_SLUG}/session.json`, '{"lastWorkspace":"start"}')
  seed(appData, `${LEGACY_SLUG}/Partitions/main/Cookies`, 'cookie-db')
  return { home, appData, root }
}

test('first run adopts both trees, keeping workspaces and the profile', () => {
  const { home, appData, root } = installFixture()
  try {
    const plan = migrateLegacyStorage({
      env: {},
      argv: ['electron', '.'],
      home,
      appDataDir: appData,
      userDataDir: join(appData, APP_SLUG),
    })

    assert.equal(plan.configRoot, join(home, '.config', APP_SLUG))
    assert.equal(plan.config.status, 'moved')
    assert.equal(plan.profile.status, 'moved')
    assert.equal(contents(home, `.config/${APP_SLUG}/session.json`), '{"lastWorkspace":"start"}')
    assert.equal(contents(home, `.config/${APP_SLUG}/workspaces/start.json`), '{"tiles":[]}')
    assert.equal(contents(appData, `${APP_SLUG}/Partitions/main/Cookies`), 'cookie-db')
    assert.equal(existsSync(join(home, `.config/${LEGACY_SLUG}`)), false)
    assert.equal(existsSync(join(appData, LEGACY_SLUG)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a second run is a no-op: it never re-merges an old tree into a live one', () => {
  const { home, appData, root } = installFixture()
  try {
    migrateLegacyStorage({ env: {}, argv: [], home, appDataDir: appData, userDataDir: join(appData, APP_SLUG) })
    // The old build runs again and recreates its own trees.
    seed(home, `.config/${LEGACY_SLUG}/workspaces/later.json`, '{"tiles":[2]}')
    seed(appData, `${LEGACY_SLUG}/Partitions/main/Cookies`, 'other-cookies')

    const plan = migrateLegacyStorage({
      env: {},
      argv: [],
      home,
      appDataDir: appData,
      userDataDir: join(appData, APP_SLUG),
    })
    assert.equal(plan.config.status, 'kept')
    assert.equal(plan.profile.status, 'kept')
    assert.equal(existsSync(join(home, `.config/${APP_SLUG}/workspaces/later.json`)), false)
    assert.equal(contents(appData, `${APP_SLUG}/Partitions/main/Cookies`), 'cookie-db')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Chromium bootstrap noise in the new profile does not block the adoption', () => {
  const { home, appData, root } = installFixture()
  try {
    // What Electron leaves behind before any of this code runs: caches, not state.
    seed(appData, `${APP_SLUG}/GPUPersistentCache/db`, 'gpu-noise')
    seed(appData, `${APP_SLUG}/Preferences`, '{}')

    const plan = migrateLegacyStorage({
      env: {},
      argv: [],
      home,
      appDataDir: appData,
      userDataDir: join(appData, APP_SLUG),
    })
    assert.equal(plan.profile.status, 'moved')
    assert.equal(contents(appData, `${APP_SLUG}/Partitions/main/Cookies`), 'cookie-db')
    // The bootstrapped directory is parked, not deleted: the evidence survives a wrong answer.
    const parked = readdirSync(appData).filter((name) => name.startsWith(`${APP_SLUG}.pre-migration-`))
    assert.equal(parked.length, 1)
    assert.equal(contents(appData, `${parked[0]}/GPUPersistentCache/db`), 'gpu-noise')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the marker is written after a decision, and a fresh install gets one too', () => {
  const { home, appData, root } = installFixture()
  try {
    const plan = migrateLegacyStorage({
      env: {},
      argv: [],
      home,
      appDataDir: appData,
      userDataDir: join(appData, APP_SLUG),
    })
    assert.equal(plan.profile.status, 'moved')
    const marker = JSON.parse(contents(appData, `${APP_SLUG}/${PROFILE_MARKER}`)) as { adoption: string }
    assert.equal(marker.adoption, 'moved')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  // No legacy installation at all: nothing to adopt, but the marker still goes down so a later
  // stray old tree can never displace a profile that is already in use.
  const fresh = sandbox()
  try {
    const home = join(fresh, 'home')
    const appData = join(fresh, 'appData')
    mkdirSync(join(appData, APP_SLUG), { recursive: true })
    const plan = migrateLegacyStorage({
      env: {},
      argv: [],
      home,
      appDataDir: appData,
      userDataDir: join(appData, APP_SLUG),
    })
    assert.equal(plan.profile.status, 'absent')
    assert.equal(existsSync(join(appData, APP_SLUG, PROFILE_MARKER)), true)
  } finally {
    rmSync(fresh, { recursive: true, force: true })
  }
})

test('a smoke run never touches a real profile', () => {
  const { home, appData, root } = installFixture()
  try {
    const plan = migrateLegacyStorage({
      env: { WAYPOINT_SMOKE: '1' },
      argv: ['electron', '.', '--smoke'],
      home,
      appDataDir: appData,
      userDataDir: join(appData, APP_SLUG),
    })
    assert.equal(plan.config.status, 'skipped')
    assert.equal(plan.profile.status, 'skipped')
    assert.equal(existsSync(join(home, `.config/${LEGACY_SLUG}`)), true)
    assert.equal(existsSync(join(appData, LEGACY_SLUG)), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the pre-rename smoke variable is still recognised', () => {
  const { home, appData, root } = installFixture()
  try {
    const plan = migrateLegacyStorage({
      env: { CANVAS_SMOKE: '1' },
      argv: [],
      home,
      appDataDir: appData,
      userDataDir: join(appData, APP_SLUG),
    })
    assert.equal(plan.config.status, 'skipped')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit profile or config root is a probe, so nothing is migrated', () => {
  const { home, appData, root } = installFixture()
  try {
    const isolated = migrateLegacyStorage({
      env: {},
      argv: ['electron', '.', '--user-data-dir=/tmp/probe'],
      home,
      appDataDir: appData,
      userDataDir: '/tmp/probe',
    })
    assert.equal(isolated.config.status, 'skipped')
    assert.equal(isolated.profile.status, 'skipped')

    const overridden = migrateLegacyStorage({
      env: { CANVAS_CONFIG_DIR: '/tmp/config-here' },
      argv: [],
      home,
      appDataDir: appData,
      userDataDir: join(appData, APP_SLUG),
    })
    assert.equal(overridden.configRoot, '/tmp/config-here')
    assert.equal(overridden.config.status, 'skipped')
    // The old tree is untouched when the caller named another one.
    assert.equal(existsSync(join(home, `.config/${LEGACY_SLUG}`)), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a running pre-rename build blocks the migration instead of corrupting it', () => {
  const { home, appData, root } = installFixture()
  try {
    // Chromium writes this while the old app owns the profile.
    writeFileSync(join(appData, LEGACY_SLUG, 'SingletonLock'), '')
    assert.equal(legacyProfileIsLive(appData), true)

    const plan = migrateLegacyStorage({
      env: {},
      argv: [],
      home,
      appDataDir: appData,
      userDataDir: join(appData, APP_SLUG),
    })
    assert.equal(plan.config.status, 'skipped')
    assert.equal(plan.profile.status, 'skipped')
    assert.equal(existsSync(join(home, `.config/${LEGACY_SLUG}/session.json`)), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
