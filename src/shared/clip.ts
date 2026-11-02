/**
 * Markdown assembly for the clip button.
 *
 * Everything here is pure so `npm test` can prove the two things that matter without a
 * running page: the frontmatter cannot be broken out of by a hostile `<title>`, and the
 * filename cannot become a path. The page supplies the title, so it is untrusted text in
 * both places — a clip that lands outside the clips directory, or one whose frontmatter
 * closes early, are the two ways this feature could go wrong quietly.
 */

export interface ClipSource {
  title: string
  url: string
  content: string
}

/** The longest title this app will carry into a heading and a filename. */
const MAX_TITLE = 300
/** A filename long enough to read, short enough to stay out of the way. */
const MAX_SLUG = 80

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g
/** Path separators are stripped, never escaped: a name that needs escaping is a bug. */
const UNSAFE_NAME = /[/\\:*?"<>|]/g

/**
 * A page's title, made safe to put in a heading, a YAML scalar and a filename's stem.
 * Control characters become spaces (a newline in a title is a line break in the
 * frontmatter), whitespace collapses, and an empty title becomes `Untitled` rather than
 * an empty heading.
 */
export function clipTitle(raw: string): string {
  const cleaned = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE).trim()
  return cleaned.length > 0 ? cleaned : 'Untitled'
}

/**
 * A double-quoted YAML scalar. `"` and `\` are the only characters that can leave a
 * double-quoted scalar early, so those are escaped and everything else is text.
 */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The clip as an Obsidian note: frontmatter with the source, then the title as a heading
 * and the page's own text beneath it.
 *
 * `clipped` is written as a quoted ISO timestamp so a note filed at midnight cannot be
 * read as a YAML date-and-time with a different timezone than the one it was filed in.
 */
export function buildClipMarkdown(source: ClipSource, clippedAt: Date): string {
  const title = clipTitle(source.title)
  // Trimmed at both ends: page text starts with the indentation of whatever wrapper it
  // came out of, and a note that opens with two blank lines reads as a mistake.
  const body = source.content.replace(/\r\n/g, '\n').trim()
  const lines = [
    '---',
    `title: ${yamlScalar(title)}`,
    `source: ${yamlScalar(source.url)}`,
    `clipped: ${yamlScalar(clippedAt.toISOString())}`,
    '---',
    '',
    `# ${title}`,
  ]
  if (body.length > 0) lines.push('', body)
  lines.push('')
  return lines.join('\n')
}

/**
 * `YYYY-MM-DD HHmm <title>.md`, in local time — a clip filed at 19:19 should read 19:19.
 *
 * The stem is the title with path separators and the characters no filesystem wants,
 * collapsed to single spaces, and stripped of leading dots so it can never be `.` or
 * `..`. A collision is resolved by the writer (`, then -2, -3, …`), not here: this
 * function never reads the disk, which is what keeps it testable.
 */
export function clipFileName(title: string, clippedAt: Date): string {
  const safe = clipTitle(title)
    .replace(UNSAFE_NAME, ' ')
    .replace(/[. ]+/g, ' ')
    .trim()
    .slice(0, MAX_SLUG)
    .replace(/[. ]+$/, '')
    .trim()
  const stem = safe.replace(/^\.+/, '').trim()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${clippedAt.getFullYear()}-${pad(clippedAt.getMonth() + 1)}-${pad(clippedAt.getDate())}`
  const time = `${pad(clippedAt.getHours())}${pad(clippedAt.getMinutes())}`
  return `${date} ${time} ${stem.length > 0 ? stem : 'Untitled'}.md`
}
