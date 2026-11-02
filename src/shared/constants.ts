export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 2

/** Title-bar height expressed in world units; it is then scaled by zoom, floored/ceilinged for usability. */
export const CHROME_WORLD_HEIGHT = 32
export const CHROME_MIN_SCREEN_H = 22
export const CHROME_MAX_SCREEN_H = 64

export const MIN_TILE_WORLD_W = 320
export const MIN_TILE_WORLD_H = 240
export const DEFAULT_TILE_WORLD_W = 760
export const DEFAULT_TILE_WORLD_H = 540

/** A group frame may not be resized below this, or its header is unusable. */
export const MIN_FRAME_WORLD_W = 200
export const MIN_FRAME_WORLD_H = 140
/** Frames a workspace may hold; a hand-edited file cannot make the canvas crawl. */
export const MAX_FRAMES_PER_WORKSPACE = 100
/** Gap between a selection and the frame drawn around it by ⌘G. */
export const FRAME_PADDING_WORLD = 48

/**
 * Cascade step, in world units, for a new tile that would otherwise land on an
 * existing one. World units (not screen px) so the staircase looks the same at
 * every zoom level.
 */
export const CASCADE_STEP_WORLD = 40
/**
 * Slots tried per axis before accepting the least-bad overlap. Sized for a full
 * default tile at one step per 40 world px (760 / 40 = 19 rightward slots), plus
 * headroom for a crowded canvas.
 */
export const CASCADE_MAX_STEPS = 40

export const GRID_WORLD_STEP = 32

/** Tile ids: they address a view and are the key the canvas model is stored under. */
export const TILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export const WORKSPACE_NAME_MAX = 64
export const MAX_TILES_PER_WORKSPACE = 200

/**
 * Quiet time after the last canvas change before the active workspace is written.
 *
 * Short enough that a quit a moment later loses nothing a person would notice,
 * long enough that a drag (which emits a change every frame while it moves) costs
 * exactly one atomic write when it stops. It lives here because the smoke run
 * waits on it: a hard-coded 500 in two places is a test that fails when one of
 * them is tuned.
 */
export const AUTOSAVE_DEBOUNCE_MS = 500

/**
 * How long the canvas may take to answer `collect` when the answer is needed by a
 * quit or a window close. Shorter than the 5 s an ordinary RPC allows: an app that
 * will not close is a worse outcome than dropping one unsaved move, and the whole
 * point of the guard is a renderer that has stopped answering.
 */
export const QUIT_COLLECT_BUDGET_MS = 1500

/** Window geometry. A restored size is clamped to these rather than trusted. */
export const DEFAULT_WINDOW_W = 1512
export const DEFAULT_WINDOW_H = 945
export const MIN_WINDOW_W = 760
export const MIN_WINDOW_H = 480

export const CANVAS_BG = '#0f0e0d'

/*
 * Chrome regions. Every floating control lives in its own WebContentsView sized
 * to exactly that region: `View` has no per-view ignore-mouse-events (only
 * BaseWindow does), so any pixel a topmost view covers swallows the click that
 * a tile underneath would have received. The one deliberate exception is the
 * pan interceptor, which is *supposed* to eat every click while it is armed.
 */
export const HUD_COMPACT_WIDTH = 300
export const HUD_COMPACT_HEIGHT = 44
export const HUD_MARGIN = 16

export const DOCK_WIDTH = 620
export const DOCK_HEIGHT = 56
export const DOCK_BOTTOM = 24
export const DOCK_MARGIN = 12

export const SIDEBAR_WIDTH = 280
/** Width of the collapsed rail: just wide enough for the expand toggle. */
export const SIDEBAR_RAIL_WIDTH = 44
export const SIDEBAR_SLIDE_MS = 160

/** Padding around the bounding box when "fit to view" picks a zoom. */
export const FIT_PADDING = 40

/**
 * Upper bound on the zoom a fit may pick. A fit is a "show me everything" move:
 * it may pull back as far as MIN_ZOOM, and may push in to 1.5x so a single
 * small tile fills a useful part of a large window — but never further, because
 * a tile blown up past 1.5x reads as a jump rather than a framing.
 */
export const FIT_MAX_ZOOM = 1.5

/**
 * How long the camera takes to fly to a tile. Long enough to read as motion,
 * short enough that a double press does not fight itself.
 */
export const CAMERA_FIT_MS = 280

export const CANVAS_PARTITION = 'persist:canvas'
export const OVERLAY_PARTITION = 'persist:overlay'
export const DOCK_PARTITION = 'persist:dock'
export const SIDEBAR_PARTITION = 'persist:sidebar'
