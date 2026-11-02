import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CLIP_DIR_ENV, firstEnv } from './config-root.ts'
import type { ClipSource } from '../shared/clip.ts'

/**
 * What the clip button reads out of a page.
 *
 * It runs in the tile's own document, which is someone else's origin: the script is a
 * string evaluated there, so it may only read and return — never write, navigate or
 * reach for anything the page does not already have. Selection wins when the user has
 * one (clipping what you highlighted is the whole gesture); otherwise the article, then
 * `main`, then the body.
 *
 * The result is structured-cloned back into main and is untrusted from there on: it is
 * validated by `readClipSource()` before a single character reaches a file, and the
 * filename is derived from the *validated* title rather than from whatever the page
 * returned.
 */
export const EXTRACTION_SCRIPT = `(() => {
  const text = (node) => (node && typeof node.innerText === 'string' ? node.innerText : '');
  const title = typeof document.title === 'string' ? document.title : '';
  const url = String(window.location.href || '');
  const selection = typeof window.getSelection === 'function' ? String(window.getSelection() || '') : '';
  const article = document.querySelector('article') || document.querySelector('main');
  const body = document.body;
  const content = selection.trim().length > 0
    ? selection
    : (article ? text(article) : text(body));
  return { title, url, content };
})()`

/** A clip is a note, not an archive: the body is bounded so one page cannot fill a disk. */
const MAX_CONTENT = 50000
const MAX_TITLE_IN = 400
const MAX_URL = 4096

/**
 * Validate what came back from the page. Junk is dropped rather than repaired, and every
 * field is bounded — the content becomes a file and the title becomes both a heading and
 * a filename, so an unbounded value from a hostile page is a real problem rather than an
 * untidy one.
 */
export function readClipSource(value: unknown): ClipSource | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.title !== 'string' || typeof record.url !== 'string') return null
  const content = typeof record.content === 'string' ? record.content : ''
  return {
    title: record.title.slice(0, MAX_TITLE_IN),
    url: record.url.slice(0, MAX_URL),
    content: content.slice(0, MAX_CONTENT),
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Writes clips into one directory, atomically.
 *
 * The same temp-file-plus-rename the workspace store uses: a crash mid-write leaves no
 * half a note, and never a truncated one where a good one used to be. A name that is
 * already taken gets `-2`, `-3`, … rather than overwriting — clipping the same page
 * twice is the normal case, and silently replacing yesterday's clip is not acceptable.
 */
export class Clipper {
  /** The directory clips are written into. */
  readonly dir: string

  // A plain field, not a constructor parameter property: `node --test` strips types
  // without transforming them, and parameter properties are not valid there.
  constructor(dir: string) {
    this.dir = dir
  }

  pathFor(name: string): string {
    return join(this.dir, name)
  }

  async write(markdown: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      await mkdir(this.dir, { recursive: true })
      const target = await this.freeName(name)
      const tmp = `${target}.${process.pid}.tmp`
      await writeFile(tmp, markdown, 'utf8')
      await rename(tmp, target)
      return { ok: true, path: target }
    } catch (error) {
      return { ok: false, error: `clip failed: ${String(error)}` }
    }
  }

  /** The first free `<stem>.md`, then `<stem>-2.md`, … — bounded, never a loop. */
  private async freeName(name: string): Promise<string> {
    const stem = name.endsWith('.md') ? name.slice(0, -'.md'.length) : name
    const first = join(this.dir, `${stem}.md`)
    if (!(await exists(first))) return first
    for (let index = 2; index <= 999; index += 1) {
      const candidate = join(this.dir, `${stem}-${index}.md`)
      if (!(await exists(candidate))) return candidate
    }
    throw new Error(`no free clip name for ${name}`)
  }
}

/** The directory a clip goes to: the environment override, or `<config root>/clips`. */
export function clipDirFor(configRoot: string): string {
  const override = firstEnv(process.env, CLIP_DIR_ENV)
  return override !== undefined ? override : join(configRoot, 'clips')
}
