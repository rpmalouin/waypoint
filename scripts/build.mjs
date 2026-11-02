// Three bundles, no dev server: main (CJS), two preloads (CJS, sandbox-safe),
// two renderer pages (IIFE). `--watch` keeps esbuild contexts alive.
import { build, context } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const watch = process.argv.includes('--watch')

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
}

/** @type {import('esbuild').BuildOptions[]} */
const configs = [
  {
    ...shared,
    entryPoints: [{ in: join(root, 'src/main/index.ts'), out: 'main/index' }],
    outdir: dist,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
  {
    ...shared,
    entryPoints: [
      { in: join(root, 'src/preload/canvas.ts'), out: 'preload/canvas' },
      { in: join(root, 'src/preload/overlay.ts'), out: 'preload/overlay' },
    ],
    outdir: dist,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
  {
    ...shared,
    entryPoints: [
      { in: join(root, 'src/renderer/main.ts'), out: 'renderer/renderer' },
      { in: join(root, 'src/renderer/overlay/main.ts'), out: 'renderer/overlay' },
    ],
    outdir: dist,
    platform: 'browser',
    format: 'iife',
    target: ['chrome130'],
  },
]

async function copyStatic() {
  await mkdir(join(dist, 'renderer'), { recursive: true })
  await cp(join(root, 'src/renderer/index.html'), join(dist, 'renderer/index.html'))
  await cp(join(root, 'src/renderer/overlay.html'), join(dist, 'renderer/overlay.html'))
  // The blocklist is data, not code: main reads it from beside its own bundle,
  // so the build has to put it there.
  await mkdir(join(dist, 'main'), { recursive: true })
  await cp(join(root, 'src/main/adblock/blocklist.txt'), join(dist, 'main/blocklist.txt'))
  // Cosmetic rules ride the same rule: main reads them from beside its bundle.
  await cp(join(root, 'src/main/adblock/cosmetic.txt'), join(dist, 'main/cosmetic.txt'))
}

if (watch) {
  const contexts = await Promise.all(configs.map((config) => context(config)))
  await Promise.all(contexts.map((ctx) => ctx.watch()))
  await copyStatic()
  console.log('[build] watching src/ → dist/')
} else {
  await rm(dist, { recursive: true, force: true })
  await Promise.all(configs.map((config) => build(config)))
  await copyStatic()
  console.log('[build] dist ready')
}
