import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { Clipper, clipDirFor, readClipSource } from '../src/main/clipper.ts'
import { buildClipMarkdown, clipFileName, clipTitle } from '../src/shared/clip.ts'
import { DARK_MODE_CSS } from '../src/shared/dark-mode.ts'

// ------------------------------------------------------------------ title hygiene

test('a page title is flattened into one line and bounded', () => {
  assert.equal(clipTitle('  Hello\n\nWorld  '), 'Hello World')
  // A NUL or any other control character would end a YAML line early; built at runtime
  // rather than typed, so this file never becomes binary to git.
  assert.equal(clipTitle(`a${String.fromCharCode(0)}b`), 'a b')
  assert.equal(clipTitle('   '), 'Untitled')
  assert.equal(clipTitle(''), 'Untitled')
  assert.ok(clipTitle('x'.repeat(1000)).length <= 300)
})

// ---------------------------------------------------------------- markdown assembly

const clippedAt = new Date('2026-11-01T19:19:00.000Z')

test('a clip carries frontmatter, the source and the page text', () => {
  const markdown = buildClipMarkdown(
    { title: 'A Page', url: 'https://example.com/a?b=1', content: '  body text  \n' },
    clippedAt,
  )
  assert.equal(
    markdown,
    [
      '---',
      'title: "A Page"',
      'source: "https://example.com/a?b=1"',
      'clipped: "2026-11-01T19:19:00.000Z"',
      '---',
      '',
      '# A Page',
      '',
      'body text',
      '',
    ].join('\n'),
  )
})

test('a hostile title cannot break out of the frontmatter or the heading', () => {
  const markdown = buildClipMarkdown(
    {
      title: 'x"\nsource: "evil\n---\n# injected',
      url: 'https://example.com/',
      content: 'body',
    },
    clippedAt,
  )
  const lines = markdown.split('\n')
  // Exactly one frontmatter block: the opening fence, three fields, the closing fence.
  assert.equal(lines[0], '---')
  assert.equal(lines[4], '---')
  // The newlines in the title became spaces, so nothing the page supplied starts a line.
  assert.equal(lines[1], 'title: "x\\" source: \\"evil --- # injected"')
  // ...and no page-supplied line looks like a YAML key of its own.
  const keys = lines.slice(1, 4).map((line) => line.slice(0, line.indexOf(':')))
  assert.deepEqual(keys, ['title', 'source', 'clipped'])
})

test('a backslash in a title is escaped, not interpreted', () => {
  const markdown = buildClipMarkdown({ title: 'C:\\temp', url: 'https://example.com/', content: '' }, clippedAt)
  assert.match(markdown, /^title: "C:\\\\temp"$/m)
})

test('an empty page body still produces a note with its heading', () => {
  const markdown = buildClipMarkdown({ title: 'Empty', url: 'https://example.com/', content: '   ' }, clippedAt)
  assert.ok(markdown.endsWith('# Empty\n'), JSON.stringify(markdown.slice(-40)))
  assert.ok(!markdown.includes('\n\n\n'), 'no run of blank lines')
})

test('CRLF in page text is normalised, because a clip is a markdown file', () => {
  const markdown = buildClipMarkdown(
    { title: 'Lines', url: 'https://example.com/', content: 'one\r\ntwo\r\n' },
    clippedAt,
  )
  assert.ok(markdown.includes('one\ntwo'))
  assert.ok(!markdown.includes('\r'))
})

// ------------------------------------------------------------------- file naming

test('a filename uses local time and never carries a path separator', () => {
  const date = new Date(2026, 10, 1, 9, 7, 0)
  assert.equal(clipFileName('A Page', date), '2026-11-01 0907 A Page.md')

  const hostile = clipFileName('../../etc/passwd', date)
  assert.equal(hostile, '2026-11-01 0907 etc passwd.md')
  assert.ok(!hostile.includes('/'))
  assert.ok(!hostile.includes('..'))
})

test('a filename never becomes dot, dot-dot, or an empty stem', () => {
  const date = new Date(2026, 0, 2, 3, 4, 0)
  assert.equal(clipFileName('', date), '2026-01-02 0304 Untitled.md')
  assert.equal(clipFileName('...', date), '2026-01-02 0304 Untitled.md')
  assert.equal(clipFileName('..', date), '2026-01-02 0304 Untitled.md')
})

test('a very long title is bounded but still legible', () => {
  const name = clipFileName('word '.repeat(200), new Date(2026, 5, 6, 7, 8, 0))
  assert.ok(name.length < 120, `name was ${name.length} chars`)
  assert.ok(name.startsWith('2026-06-06 0708 word'))
  assert.ok(name.endsWith('.md'))
})

// ------------------------------------------------------------------ the writer

test('the clipper writes a note and never overwrites the last one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-clip-'))
  try {
    const clipper = new Clipper(join(root, 'clips'))
    const name = '2026-11-01 1925 Page.md'
    const first = await clipper.write('one', name)
    const second = await clipper.write('two', name)
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.notEqual(first.path, second.path)
    assert.equal(await readFile(first.path!, 'utf8'), 'one')
    assert.equal(await readFile(second.path!, 'utf8'), 'two')
    assert.match(basename(second.path!), /-2\.md$/)
    // The directory is created on first write, and no temp file survives the rename.
    assert.deepEqual((await readdir(join(root, 'clips'))).sort(), ['2026-11-01 1925 Page-2.md', '2026-11-01 1925 Page.md'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('what a page hands back is validated, not trusted', () => {
  assert.equal(readClipSource(null), null)
  assert.equal(readClipSource('nope'), null)
  assert.equal(readClipSource([]), null)
  // A title or URL that is not text is not a clip.
  assert.equal(readClipSource({ title: 1, url: 'https://example.com' }), null)
  assert.equal(readClipSource({ title: 'a', url: null }), null)
  assert.equal(readClipSource({ title: 'a', url: 'https://example.com', content: 'c' })?.content, 'c')
  // A page cannot smuggle a non-string body, and the body has a ceiling.
  assert.equal(readClipSource({ title: 'a', url: 'https://example.com', content: { evil: true } })?.content, '')
  assert.equal(readClipSource({ title: 'a', url: 'https://example.com', content: 'x'.repeat(90000) })?.content.length, 50000)
})

test('the clip directory prefers the environment override, new name first', () => {
  const savedNew = process.env.WAYPOINT_CLIP_DIR
  const savedOld = process.env.CANVAS_CLIP_DIR
  try {
    delete process.env.WAYPOINT_CLIP_DIR
    delete process.env.CANVAS_CLIP_DIR
    process.env.WAYPOINT_CLIP_DIR = '/tmp/clips-here'
    assert.equal(clipDirFor('/config'), '/tmp/clips-here')
    // The pre-rename variable is still honoured, so an old launcher keeps working.
    delete process.env.WAYPOINT_CLIP_DIR
    process.env.CANVAS_CLIP_DIR = '/tmp/legacy-clips'
    assert.equal(clipDirFor('/config'), '/tmp/legacy-clips')
    // And the new name wins when both are set, rather than the pair being a coin flip.
    process.env.WAYPOINT_CLIP_DIR = '/tmp/clips-here'
    assert.equal(clipDirFor('/config'), '/tmp/clips-here')
    delete process.env.WAYPOINT_CLIP_DIR
    delete process.env.CANVAS_CLIP_DIR
    assert.equal(clipDirFor('/config'), '/config/clips')
  } finally {
    if (savedNew === undefined) delete process.env.WAYPOINT_CLIP_DIR
    else process.env.WAYPOINT_CLIP_DIR = savedNew
    if (savedOld === undefined) delete process.env.CANVAS_CLIP_DIR
    else process.env.CANVAS_CLIP_DIR = savedOld
  }
})

// ---------------------------------------------------------------------- dark css

test('the dark stylesheet inverts the document and re-inverts its media', () => {
  assert.match(DARK_MODE_CSS, /html\s*{[^}]*invert\(/)
  assert.match(DARK_MODE_CSS, /html\s*{[^}]*hue-rotate\(180deg\)/)
  // Two rules decide whether this is usable: the root is inverted, and images are put
  // back the way they were. Dropping the second turns every photo into a negative.
  assert.match(DARK_MODE_CSS, /img,[\s\S]*filter:\s*invert\(1\)/)
  assert.match(DARK_MODE_CSS, /!important/)
})
