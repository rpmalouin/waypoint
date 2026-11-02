import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceStore, readWindowState } from '../src/main/workspaces.ts'
import { DEFAULT_THEME } from '../src/shared/theme.ts'
import type { WorkspaceTheme } from '../src/shared/theme.ts'
import type { CanvasSnapshot } from '../src/shared/types.ts'

async function withStore(run: (store: WorkspaceStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'waypoint-test-'))
  try {
    await run(new WorkspaceStore(root), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const snapshot: CanvasSnapshot = {
  viewport: { panX: 120.5, panY: -80.25, zoom: 1.5 },
  tiles: [
    { id: 'tile-a', url: 'https://example.com', title: 'Example', world: { x: 0, y: 0, width: 760, height: 540 } },
    { id: 'tile-b', url: 'about:blank', title: '', world: { x: 800, y: 40, width: 400, height: 300 } },
  ],
}

test('save writes flat JSON and load returns the same canvas', async () => {
  await withStore(async (store, root) => {
    const result = await store.save('work', snapshot)
    assert.deepEqual(result, { ok: true, name: 'work' })

    const raw = await readFile(join(root, 'workspaces', 'work.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version: number; name: string; viewport: unknown; tiles: unknown[] }
    assert.equal(parsed.version, 1)
    assert.equal(parsed.name, 'work')
    assert.deepEqual(parsed.viewport, snapshot.viewport)
    assert.equal(parsed.tiles.length, 2)

    const loaded = await store.load('work')
    assert.ok(loaded)
    assert.deepEqual(loaded.viewport, snapshot.viewport)
    assert.deepEqual(loaded.tiles, snapshot.tiles)
    assert.equal(loaded.name, 'work')
    assert.equal(typeof loaded.savedAt, 'string')
  })
})

test('save refuses unsafe names without touching the filesystem', async () => {
  await withStore(async (store, root) => {
    for (const name of ['../escape', 'has space', 'UPPER', '..', '']) {
      const result = await store.save(name, snapshot)
      assert.equal(result.ok, false, `${name} should be rejected`)
    }
    await assert.rejects(readdir(join(root, 'workspaces')), 'no directory should be created')
  })
})

test('list reports only valid workspace files, sorted', async () => {
  await withStore(async (store, root) => {
    await store.save('zeta', snapshot)
    await store.save('alpha', snapshot)
    const dir = join(root, 'workspaces')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'NOT VALID.json'), '{}', 'utf8')
    await writeFile(join(dir, 'notes.txt'), '{}', 'utf8')

    assert.deepEqual(await store.list(), ['alpha', 'zeta'])
  })
})

test('load rejects traversal, missing files and broken JSON', async () => {
  await withStore(async (store, root) => {
    assert.equal(await store.load('../etc/passwd'), null)
    assert.equal(await store.load('nope'), null)

    const dir = join(root, 'workspaces')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8')
    assert.equal(await store.load('broken'), null)
  })
})

test('load drops untrusted tiles and clamps the viewport', async () => {
  await withStore(async (store, root) => {
    const dir = join(root, 'workspaces')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'mixed.json'),
      JSON.stringify({
        version: 99,
        name: 'Mismatched Name',
        viewport: { panX: 'nope', panY: 10, zoom: 99 },
        tiles: [
          { id: 'ok', url: 'https://example.com', title: 'ok', world: { x: 0, y: 0, width: 10, height: 10 } },
          { id: 'bad id', url: 'https://example.com', world: { x: 0, y: 0, width: 10, height: 10 } },
          { id: 'js', url: 'javascript:alert(1)', world: { x: 0, y: 0, width: 10, height: 10 } },
          { id: 'noworld', url: 'https://example.com' },
          'not an object',
        ],
      }),
      'utf8',
    )

    const loaded = await store.load('mixed')
    assert.ok(loaded)
    assert.equal(loaded.name, 'mixed', 'invalid stored name falls back to the file name')
    assert.equal(loaded.viewport.panX, 0)
    assert.equal(loaded.viewport.panY, 10)
    assert.equal(loaded.viewport.zoom, 2, 'zoom is clamped to the canvas range')
    assert.deepEqual(
      loaded.tiles.map((tile) => tile.id),
      ['ok'],
      'only well-formed, navigable tiles survive',
    )
    assert.ok(loaded.tiles[0]!.world.width >= 64, 'degenerate sizes are floored')
  })
})

test('save is atomic: no temp files survive, repeat saves overwrite', async () => {
  await withStore(async (store, root) => {
    await store.save('work', snapshot)
    await store.save('work', { viewport: { panX: 0, panY: 0, zoom: 1 }, tiles: [] })

    const entries = await readdir(join(root, 'workspaces'))
    assert.deepEqual(entries, ['work.json'])

    const loaded = await store.load('work')
    assert.ok(loaded)
    assert.equal(loaded.tiles.length, 0)
  })
})

test('remove deletes a workspace and forgets nothing else', async () => {
  await withStore(async (store) => {
    await store.save('one', snapshot)
    await store.save('two', snapshot)
    assert.equal(await store.remove('one'), true)
    assert.equal(await store.remove('../nope'), false)
    assert.deepEqual(await store.list(), ['two'])
  })
})

test('session only remembers workspaces that still exist', async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.session(), { lastWorkspace: null, workspaces: [], cosmeticPaused: [] })

    await store.save('work', snapshot)
    await store.rememberLast('work')
    assert.deepEqual(await store.session(), { lastWorkspace: 'work', workspaces: ['work'], cosmeticPaused: [] })

    await store.remove('work')
    assert.deepEqual(await store.session(), { lastWorkspace: null, workspaces: [], cosmeticPaused: [] })
  })
})

test('the cosmetic pause list and the last workspace share a file without clobbering each other', async () => {
  await withStore(async (store) => {
    await store.save('work', snapshot)
    await store.rememberLast('work')
    await store.persistCosmeticPaused(['example.com', 'news.test'])

    const both = await store.session()
    assert.deepEqual(both.cosmeticPaused, ['example.com', 'news.test'])
    // The merge is the point: writing the pause list must not forget the workspace.
    assert.equal(both.lastWorkspace, 'work')

    // And the other direction: remembering a workspace keeps the pause list.
    await store.rememberLast('work')
    assert.deepEqual((await store.session()).cosmeticPaused, ['example.com', 'news.test'])

    await store.persistCosmeticPaused([])
    assert.deepEqual((await store.session()).cosmeticPaused, [])
    assert.equal((await store.session()).lastWorkspace, 'work')
  })
})

test('a tile keeps its own container across save and load', async () => {
  await withStore(async (store, root) => {
    const containerSnapshot: CanvasSnapshot = {
      viewport: { panX: 0, panY: 0, zoom: 1 },
      tiles: [
        {
          id: 'work-a',
          url: 'https://example.com',
          title: 'Work',
          partition: 'persist:work',
          world: { x: 0, y: 0, width: 760, height: 540 },
        },
        { id: 'plain-a', url: 'https://example.com', title: 'Plain', world: { x: 800, y: 0, width: 760, height: 540 } },
        {
          id: 'temp-a',
          url: 'https://example.com',
          title: 'Private',
          partition: 'temp:private',
          world: { x: 1600, y: 0, width: 760, height: 540 },
        },
      ],
    }

    assert.deepEqual(await store.save('containers', containerSnapshot), { ok: true, name: 'containers' })

    const raw = JSON.parse(await readFile(join(root, 'workspaces', 'containers.json'), 'utf8')) as {
      tiles: Record<string, unknown>[]
    }
    assert.equal(raw.tiles[0]?.partition, 'persist:work', 'the container string is written verbatim')
    assert.equal(raw.tiles[1] && 'partition' in raw.tiles[1], false, 'a default tile writes no partition at all')
    assert.equal(raw.tiles[2]?.partition, 'temp:private', 'an in-memory container is preserved too')

    const loaded = await store.load('containers')
    assert.ok(loaded)
    assert.equal(loaded.tiles[0]?.partition, 'persist:work')
    assert.equal(loaded.tiles[1]?.partition, undefined)
    assert.equal(loaded.tiles[2]?.partition, 'temp:private')
  })
})

test('a hostile partition is dropped, not carried into a view', async () => {
  await withStore(async (store, root) => {
    const dir = join(root, 'workspaces')
    await mkdir(dir, { recursive: true })
    const tile = (id: string, partition: unknown): Record<string, unknown> => ({
      id,
      url: 'https://example.com',
      title: id,
      partition,
      world: { x: 0, y: 0, width: 760, height: 540 },
    })
    await writeFile(
      join(dir, 'badparts.json'),
      JSON.stringify({
        version: 1,
        name: 'badparts',
        viewport: { panX: 0, panY: 0, zoom: 1 },
        tiles: [
          tile('traversal', 'persist:../../etc'),
          tile('slash', 'persist:work/extra'),
          tile('long', 'persist:' + 'x'.repeat(65)),
          tile('number', 42),
          tile('good', 'persist:good'),
        ],
      }),
      'utf8',
    )

    const loaded = await store.load('badparts')
    assert.ok(loaded)
    assert.deepEqual(
      loaded.tiles.map((entry) => entry.partition),
      [undefined, undefined, undefined, undefined, 'persist:good'],
      'only the well-formed container survives; the rest fall back to the shared jar',
    )
  })
})

// ------------------------------------------------------------------ frames

const framedSnapshot: CanvasSnapshot = {
  viewport: { panX: 40, panY: -20, zoom: 0.8 },
  tiles: snapshot.tiles,
  frames: [
    { id: 'frame-a1', name: 'HOA Accounting', worldX: -60, worldY: -40, worldW: 900, worldH: 700, color: '#4A90E2' },
    { id: 'frame-b2', name: 'Claude Research', worldX: 800, worldY: 400, worldW: 500, worldH: 400 },
  ],
}

test('frames round-trip through the workspace file', async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.save('zones', framedSnapshot), { ok: true, name: 'zones' })
    const loaded = await store.load('zones')
    assert.ok(loaded?.frames)
    assert.equal(loaded.frames.length, 2)
    assert.deepEqual(loaded.frames[0], {
      id: 'frame-a1',
      name: 'HOA Accounting',
      worldX: -60,
      worldY: -40,
      worldW: 900,
      worldH: 700,
      color: '#4a90e2',
    })
    assert.equal(loaded.frames[1]?.color, undefined, 'no colour means the default tint')
  })
})

test('a canvas without frames keeps the pre-frame file shape', async () => {
  await withStore(async (store, root) => {
    await store.save('plain', snapshot)
    const raw = JSON.parse(await readFile(join(root, 'workspaces', 'plain.json'), 'utf8')) as Record<string, unknown>
    assert.equal('frames' in raw, false, 'no frames key is invented for a workspace that has none')
  })
})

test('hostile frames are dropped, clamped or normalised, never carried into the canvas', async () => {
  await withStore(async (store, root) => {
    const dir = join(root, 'workspaces')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'badframes.json'),
      JSON.stringify({
        version: 1,
        name: 'badframes',
        viewport: { panX: 0, panY: 0, zoom: 1 },
        tiles: [],
        frames: [
          { id: '../escape', name: 'traversal', worldX: 0, worldY: 0, worldW: 400, worldH: 300 },
          { id: 'frame-nan', name: 'nan', worldX: null, worldY: 0, worldW: 400, worldH: 300 },
          { id: 'frame-tiny', name: '  tiny  ', worldX: 1, worldY: 2, worldW: 2, worldH: 2, color: 'red;}body{display:none' },
          { id: 'frame-tiny', name: 'duplicate id', worldX: 0, worldY: 0, worldW: 400, worldH: 300 },
          { id: 'frame-ok', name: 'x'.repeat(200), worldX: 0, worldY: 0, worldW: 400, worldH: 300, color: '#00FF88' },
        ],
      }),
      'utf8',
    )

    const loaded = await store.load('badframes')
    assert.ok(loaded?.frames)
    assert.deepEqual(
      loaded.frames.map((frame) => frame.id),
      ['frame-tiny', 'frame-ok'],
      'bad ids and duplicate ids are dropped, not repaired',
    )
    const [tiny, ok] = loaded.frames
    assert.equal(tiny?.worldW, 200, 'a frame is floored at the minimum usable width')
    assert.equal(tiny?.worldH, 140)
    assert.equal(tiny?.color, undefined, 'a colour that is not #rrggbb is refused')
    assert.equal(ok?.name.length, 64, 'a frame name is bounded')
    assert.equal(ok?.color, '#00ff88')
  })
})

// ------------------------------------------------------- workspace files

test('rename writes the new file, unlinks the old one and refuses collisions', async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.duplicate('missing'), { ok: false, error: 'workspace "missing" not found' })

    await store.save('old-name', framedSnapshot)
    assert.deepEqual(await store.rename('old-name', 'new-name'), { ok: true, name: 'new-name' })
    assert.equal(await store.exists('old-name'), false, 'the old file is gone')
    assert.equal(await store.exists('new-name'), true)

    const renamed = await store.load('new-name')
    assert.equal(renamed?.name, 'new-name')
    assert.deepEqual(renamed?.tiles, snapshot.tiles)
    assert.equal(renamed?.frames?.length, 2, 'frames travel with a rename')

    await store.save('occupied', snapshot)
    const collision = await store.rename('new-name', 'occupied')
    assert.equal(collision.ok, false)
    assert.equal(await store.exists('new-name'), true, 'a refused rename never loses the source')

    for (const bad of ['../escape', 'Has Space', 'UPPER', '']) {
      assert.equal((await store.rename('new-name', bad)).ok, false, `${bad} must be refused`)
    }
    assert.equal((await store.rename('new-name', 'new-name')).ok, true, 'a rename to itself is a no-op')
  })
})

test('duplicate clones the canvas under a fresh name, twice over', async () => {
  await withStore(async (store, root) => {
    await store.save('base', framedSnapshot)
    assert.deepEqual(await store.duplicate('base'), { ok: true, name: 'base-copy' })
    assert.deepEqual(await store.duplicate('base'), { ok: true, name: 'base-copy-2' })

    const copy = await store.load('base-copy')
    assert.deepEqual(copy?.tiles, framedSnapshot.tiles)
    assert.deepEqual(copy?.frames, (await store.load('base'))?.frames)

    // A duplicate is a separate file: editing it leaves the original alone.
    await store.save('base-copy', { viewport: snapshot.viewport, tiles: [] })
    assert.equal((await store.load('base'))?.tiles.length, 2)
    const original = await readFile(join(root, 'workspaces', 'base.json'), 'utf8')
    const edited = await readFile(join(root, 'workspaces', 'base-copy.json'), 'utf8')
    assert.notEqual(original, edited)
  })
})

const dayTheme: WorkspaceTheme = {
  mode: 'day',
  harmony: 'triad',
  baseHue: 210,
  vivid: 70,
  grain: 35,
  colors: ['#f6e7c8', '#e9c9a8', '#d9b7c9'],
  angle: 315,
}

const themedSnapshot: CanvasSnapshot = { ...snapshot, theme: dayTheme }

test('a themed workspace writes its theme and reads it back whole', async () => {
  await withStore(async (store, root) => {
    assert.deepEqual(await store.save('themed', themedSnapshot), { ok: true, name: 'themed' })
    const raw = JSON.parse(await readFile(join(root, 'workspaces', 'themed.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(raw.theme, dayTheme)
    assert.deepEqual((await store.load('themed'))?.theme, dayTheme)
  })
})

test('the default theme is the absence of a theme, so untouched files keep their shape', async () => {
  await withStore(async (store, root) => {
    // No theme at all.
    await store.save('plain', snapshot)
    const plain = JSON.parse(await readFile(join(root, 'workspaces', 'plain.json'), 'utf8')) as Record<string, unknown>
    assert.equal('theme' in plain, false)
    assert.equal((await store.load('plain'))?.theme, undefined)

    // Explicitly the default: same file shape, because that is what absent means.
    await store.save('defaulted', { ...snapshot, theme: DEFAULT_THEME })
    const defaulted = JSON.parse(
      await readFile(join(root, 'workspaces', 'defaulted.json'), 'utf8'),
    ) as Record<string, unknown>
    assert.equal('theme' in defaulted, false)
    assert.equal((await store.load('defaulted'))?.theme, undefined)
  })
})

test('a hand-edited theme is repaired field by field, not trusted and not discarded', async () => {
  await withStore(async (store, root) => {
    // Written by hand: a hue past the range, a mode that no longer exists, one bad
    // colour, an unknown harmony, and a grain of text.
    await mkdir(join(root, 'workspaces'), { recursive: true })
    await writeFile(
      join(root, 'workspaces', 'hand.json'),
      JSON.stringify({
        version: 1,
        name: 'hand',
        savedAt: '2026-01-01T00:00:00.000Z',
        viewport: { panX: 0, panY: 0, zoom: 1 },
        tiles: [],
        theme: {
          mode: 'auto',
          harmony: 'octave',
          baseHue: 400,
          vivid: 55.7,
          grain: 'lots',
          colors: ['#AABBCC', 'red', '#112233'],
          angle: -30,
        },
      }),
      'utf8',
    )
    const theme = (await store.load('hand'))?.theme
    assert.deepEqual(theme, {
      mode: 'night',
      // An unknown harmony falls back to `free` by contract, and `free` keeps the
      // stops the file actually named.
      harmony: 'free',
      baseHue: 360,
      vivid: 56,
      grain: DEFAULT_THEME.grain,
      colors: ['#aabbcc', '#112233'],
      angle: 0,
    })
  })
})

test('duplicate and rename carry the theme; a copy is not a reset', async () => {
  await withStore(async (store) => {
    await store.save('themed', themedSnapshot)
    assert.deepEqual(await store.duplicate('themed'), { ok: true, name: 'themed-copy' })
    assert.deepEqual((await store.load('themed-copy'))?.theme, dayTheme)

    assert.deepEqual(await store.rename('themed', 'moved'), { ok: true, name: 'moved' })
    assert.deepEqual((await store.load('moved'))?.theme, dayTheme)
  })
})

const layeredSnapshot: CanvasSnapshot = { ...snapshot, stack: ['tile-b', 'tile-a'] }

test('a re-ordered workspace writes its layer order and reads it back', async () => {
  await withStore(async (store, root) => {
    await store.save('layered', layeredSnapshot)
    const raw = await readFile(join(root, 'workspaces', 'layered.json'), 'utf8')
    const parsed = JSON.parse(raw) as { stack?: unknown }
    // Back to front, as the canvas applies it: tile-b is behind tile-a here.
    assert.deepEqual(parsed.stack, ['tile-b', 'tile-a'])
    assert.deepEqual((await store.load('layered'))?.stack, ['tile-b', 'tile-a'])
  })
})

test('creation order is the absence of an order, so untouched files keep their shape', async () => {
  await withStore(async (store, root) => {
    // No `stack` at all: the common case, and the one a new feature must not grow a key for.
    await store.save('plain', snapshot)
    const plain = JSON.parse(await readFile(join(root, 'workspaces', 'plain.json'), 'utf8')) as Record<string, unknown>
    assert.equal('stack' in plain, false)

    // ...and an order that happens to equal the tiles' own order is the same thing,
    // so a client that always sends one cannot make every file grow the key.
    await store.save('same-order', { ...snapshot, stack: ['tile-a', 'tile-b'] })
    const same = JSON.parse(await readFile(join(root, 'workspaces', 'same-order.json'), 'utf8')) as Record<string, unknown>
    assert.equal('stack' in same, false)
  })
})

test('a hostile layer order is dropped rather than carried into the canvas', async () => {
  await withStore(async (store, root) => {
    await mkdir(join(root, 'workspaces'), { recursive: true })
    // Unknown ids address nothing, duplicates are not a total order, and a tile the
    // list forgot still needs a position: the loader repairs the *list*, never the ids.
    await writeFile(
      join(root, 'workspaces', 'hostile.json'),
      JSON.stringify({
        version: 1,
        name: 'hostile',
        savedAt: '2026-01-01T00:00:00.000Z',
        viewport: { panX: 0, panY: 0, zoom: 1 },
        tiles: [
          { id: 'tile-a', url: 'https://example.com', title: 'a', world: { x: 0, y: 0, width: 760, height: 540 } },
          { id: 'tile-b', url: 'https://example.org', title: 'b', world: { x: 800, y: 0, width: 760, height: 540 } },
        ],
        stack: ['ghost', 'tile-b', 'tile-b', 42, null, ''],
      }),
      'utf8',
    )
    const loaded = await store.load('hostile')
    assert.deepEqual(loaded?.stack, ['tile-b', 'tile-a'])
    // A stack that is not a list at all is simply absent.
    await writeFile(
      join(root, 'workspaces', 'notalist.json'),
      JSON.stringify({
        version: 1,
        name: 'notalist',
        savedAt: '2026-01-01T00:00:00.000Z',
        viewport: { panX: 0, panY: 0, zoom: 1 },
        tiles: [{ id: 'tile-a', url: 'https://example.com', title: 'a', world: { x: 0, y: 0, width: 760, height: 540 } }],
        stack: 'tile-a',
      }),
      'utf8',
    )
    assert.equal((await store.load('notalist'))?.stack, undefined)
  })
})

test('duplicate and rename carry the layer order; a copy is not a reshuffle', async () => {
  await withStore(async (store) => {
    await store.save('layered', layeredSnapshot)
    assert.deepEqual(await store.duplicate('layered'), { ok: true, name: 'layered-copy' })
    assert.deepEqual((await store.load('layered-copy'))?.stack, ['tile-b', 'tile-a'])

    assert.deepEqual(await store.rename('layered', 'reordered'), { ok: true, name: 'reordered' })
    assert.deepEqual((await store.load('reordered'))?.stack, ['tile-b', 'tile-a'])
  })
})

test('dark mode is written only while a tile is dark, and survives the round trip', async () => {
  await withStore(async (store, root) => {
    // A workspace nobody darkened writes no key on any tile: the absence rule that keeps
    // pre-feature files byte-identical.
    await store.save('plain', snapshot)
    const plain = JSON.parse(await readFile(join(root, 'workspaces', 'plain.json'), 'utf8')) as {
      tiles: Array<Record<string, unknown>>
    }
    assert.equal('darkMode' in plain.tiles[0]!, false)
    assert.equal('darkMode' in plain.tiles[1]!, false)

    // One dark tile, one light: only the dark one carries the flag, and it reads back.
    await store.save('dark', {
      ...snapshot,
      tiles: [{ ...snapshot.tiles[0]!, darkMode: true }, snapshot.tiles[1]!],
    })
    const written = JSON.parse(await readFile(join(root, 'workspaces', 'dark.json'), 'utf8')) as {
      tiles: Array<Record<string, unknown>>
    }
    assert.equal(written.tiles[0]?.darkMode, true)
    assert.equal('darkMode' in written.tiles[1]!, false)
    const loaded = await store.load('dark')
    assert.equal(loaded?.tiles[0]?.darkMode, true)
    assert.equal(loaded?.tiles[1]?.darkMode, undefined)

    // Only the boolean is a state this app knows: a hand-edited "yes" or an explicit
    // false is dropped, not coerced into "dark".
    await mkdir(join(root, 'workspaces'), { recursive: true })
    await writeFile(
      join(root, 'workspaces', 'hostile-dark.json'),
      JSON.stringify({
        version: 1,
        name: 'hostile-dark',
        savedAt: '2026-01-01T00:00:00.000Z',
        viewport: { panX: 0, panY: 0, zoom: 1 },
        tiles: [
          { id: 'tile-a', url: 'https://example.com', title: 'a', world: { x: 0, y: 0, width: 760, height: 540 }, darkMode: 'yes' },
          { id: 'tile-b', url: 'https://example.org', title: 'b', world: { x: 800, y: 0, width: 760, height: 540 }, darkMode: false },
        ],
      }),
      'utf8',
    )
    const hostile = await store.load('hostile-dark')
    assert.equal(hostile?.tiles[0]?.darkMode, undefined)
    assert.equal(hostile?.tiles[1]?.darkMode, undefined)
  })
})

test('window geometry is remembered beside the workspace and the pause list', async () => {
  await withStore(async (store, root) => {
    // Nothing remembered yet: the session answers no geometry, and the sync reader the
    // shell uses says "maximize", which is what every launch did before this existed.
    assert.equal((await store.session()).windowBounds, undefined)
    assert.deepEqual(readWindowState(root), { bounds: null, maximized: true })

    await store.save('work', snapshot)
    await store.rememberLast('work')
    await store.persistCosmeticPaused(['example.com'])
    await store.rememberWindow({ x: 120, y: 64, width: 1400, height: 900 }, false)

    const session = await store.session()
    assert.deepEqual(session.windowBounds, { x: 120, y: 64, width: 1400, height: 900 })
    assert.equal(session.windowMaximized, false)
    // The point of the merge: remembering the window must not forget the rest of the file.
    assert.equal(session.lastWorkspace, 'work')
    assert.deepEqual(session.cosmeticPaused, ['example.com'])

    // And the other direction, which is the bug this file already had once.
    await store.rememberLast('work')
    assert.deepEqual((await store.session()).windowBounds, { x: 120, y: 64, width: 1400, height: 900 })
    await store.persistCosmeticPaused([])
    assert.deepEqual((await store.session()).windowBounds, { x: 120, y: 64, width: 1400, height: 900 })

    assert.deepEqual(readWindowState(root), {
      bounds: { x: 120, y: 64, width: 1400, height: 900 },
      maximized: false,
    })

    // Maximized travels with the rect: a full-screen frame must not be restored as the
    // size the user chose.
    await store.rememberWindow({ x: 0, y: 0, width: 1512, height: 945 }, true)
    assert.equal((await store.session()).windowMaximized, true)
    assert.equal(readWindowState(root).maximized, true)
  })
})

test('a remembered window rect is clamped, and a malformed one is not restored', async () => {
  await withStore(async (store, root) => {
    await mkdir(root, { recursive: true })
    // Too small to be a usable window: floored rather than restored as an 80px strip.
    await writeFile(
      join(root, 'session.json'),
      JSON.stringify({ windowBounds: { x: 10, y: 10, width: 80, height: 40 }, windowMaximized: false }),
      'utf8',
    )
    assert.deepEqual(readWindowState(root).bounds, { x: 10, y: 10, width: 760, height: 480 })

    // A rect with a missing field is not a rect: the shell falls back to its own size.
    await writeFile(join(root, 'session.json'), JSON.stringify({ windowBounds: { x: 10, y: 10 } }), 'utf8')
    assert.equal(readWindowState(root).bounds, null)
    assert.equal((await store.session()).windowBounds, undefined)

    // Non-numeric garbage on one field is the same answer, and a string is never coerced.
    await writeFile(
      join(root, 'session.json'),
      JSON.stringify({ windowBounds: { x: 'left', y: 0, width: 900, height: 700 } }),
      'utf8',
    )
    assert.equal(readWindowState(root).bounds, null)

    // A file that is not JSON at all must not throw on the boot path.
    await writeFile(join(root, 'session.json'), 'not json', 'utf8')
    assert.deepEqual(readWindowState(root), { bounds: null, maximized: true })
    assert.equal((await store.session()).lastWorkspace, null)
  })
})

