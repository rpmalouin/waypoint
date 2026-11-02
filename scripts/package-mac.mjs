// Assemble the macOS app bundle with the Electron org's packager.
//
// This script packages only. Gates, signing, verification and installation are
// `scripts/build-app.sh` — signing has to happen after this, because rewriting Info.plist
// invalidates whatever signature the Electron distribution arrived with.
//
// Why a staging directory: this app's `main` is `dist/main/index.js`, and `dist/` is also where
// the finished bundle has to appear, so the packager refuses the repo root as its input ("the out
// directory is inside your app directory and contains your app's main entry point"). It is right
// to refuse. Staging exactly `package.json` + the build output gives the packager a clean input
// whose output can live inside `dist/`, and makes the bundle's contents a decision made here
// rather than a list of things to exclude from the repo.

import { packager } from '@electron/packager'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The Electron version actually installed, not the range in `package.json`.
 *
 * It has to be passed explicitly: the packager's usual inference is `require.resolve` from the
 * app directory, and the staged app has no `node_modules` to resolve through. Reading the
 * installed copy also means the bundle is built from the same Electron the dev runs use, and a
 * mismatch shows up here rather than as a bundle nobody tested.
 */
const electronVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'),
).version

/** Matches the name the app reports, the bundle on disk, and the plist's display name. */
const NAME = 'Waypoint'
const BUNDLE_ID = 'com.local.waypoint'
const ARCH = 'arm64'

/**
 * Copy the two things the app actually runs from: its manifest and the build output.
 *
 * Sourcemaps are left behind (nothing reads them without DevTools, and they point at paths that
 * are not in the bundle), as is a previous run's bundle when it is still sitting in `dist/`.
 */
async function stageApp(stage) {
  await mkdir(stage, { recursive: true })
  await cp(join(root, 'package.json'), join(stage, 'package.json'))
  await cp(join(root, 'dist'), join(stage, 'dist'), {
    recursive: true,
    filter: (source) => !source.endsWith('.map') && !source.includes(`${NAME}-darwin-`),
  })
}

// No icon ships with this repo. Inventing one is a design decision, not a packaging one, so the
// bundle keeps the Electron icon until there is a real asset; drop an `assets/icon.icns` in and
// this picks it up with no other change.
const icon = join(root, 'assets/icon.icns')
const iconPath = existsSync(icon) ? icon : undefined
if (iconPath === undefined) console.log('[package] no assets/icon.icns — using the Electron icon')

const stage = await mkdtemp(join(tmpdir(), 'cb-package-'))
let bundles
try {
  await stageApp(stage)

  bundles = await packager({
    dir: stage,
    name: NAME,
    platform: 'darwin',
    arch: ARCH,
    electronVersion,
    out: join(root, 'dist'),
    overwrite: true,
    // Nothing to prune: the staged app has no node_modules at all. Everything except `electron`
    // is inlined by esbuild, and the runtime provides Electron.
    prune: false,
    // Unpacked on purpose. Nothing writes into the bundle, and a release whose internals can be
    // read with `ls` is worth more here than an archive the app never needs.
    asar: false,
    appBundleId: BUNDLE_ID,
    appCategoryType: 'public.app-category.productivity',
    // A statement of what the bundle contains, not a copyright claim: this is an ad-hoc local
    // build with no publisher behind it.
    appCopyright: 'Ad-hoc local build. Bundles Electron (MIT) and Chromium (BSD-3-Clause).',
    icon: iconPath,
  })
} finally {
  await rm(stage, { recursive: true, force: true })
}

for (const bundle of bundles ?? []) {
  console.log(`[package] ${bundle}`)
}
