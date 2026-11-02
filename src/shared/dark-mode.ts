/**
 * The stylesheet a tile wears while dark mode is on.
 *
 * It is inserted with `webContents.insertCSS()`, which is the only mechanism this app
 * has for styling a page it does not own: the tile is a sandboxed document in someone
 * else's origin, so nothing in the canvas can reach it and nothing is shipped as an
 * extension.
 *
 * Two rules make the inversion readable rather than silly:
 *
 * - the root element is inverted *and* hue-rotated 180°, which is what turns the
 *   characteristic "photo negative" look of a plain `invert()` into something closer to
 *   a dark theme;
 * - media is inverted a second time, so an image ends up back where it started. A page
 *   whose photographs are negative-coloured is worse than one that stays light.
 *
 * Known artefact, not a bug to fix here: `filter` on the root element creates a
 * containing block, so a page with a `position: fixed` header will scroll that header
 * with the document while dark mode is on. That is why this is a per-tile toggle rather
 * than an always-on theme (see README's known limits).
 */
export const DARK_MODE_CSS = `html {
  filter: invert(0.92) hue-rotate(180deg) !important;
  background: #141418 !important;
}

img,
video,
canvas,
svg,
[style*="background-image"],
picture,
iframe {
  filter: invert(1) hue-rotate(180deg) !important;
}

/* Inverted pages that still paint a white body leave a flash and a white margin. */
body {
  background-color: #101014 !important;
}
`
