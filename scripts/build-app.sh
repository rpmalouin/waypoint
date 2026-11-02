#!/usr/bin/env bash
# Build the standalone macOS app: gates, bundle, verify, sign, install.
#
#   npm run build:app                  the whole pipeline
#   SKIP_GATES=1 ./scripts/build-app.sh     skip check/smoke while iterating on packaging
#   SKIP_LAUNCH=1 ./scripts/build-app.sh    skip the bundled --smoke launch assertion
#   SKIP_INSTALL=1 ./scripts/build-app.sh   leave the bundle in dist/, touch nothing in /Applications
#   SKIP_PACKAGE=1 ./scripts/build-app.sh   verify/sign/install the bundle already in dist/ (a second
#                                           pass over a bundle the first pass built and checked)
#
# WAYPOINT_APP_DEST overrides the install path (default /Applications/Waypoint.app); the
# pre-rename CANVAS_APP_DEST is still read, so an old rehearsal script keeps working.
#
# No sudo anywhere: /Applications is group-admin writable on this Mac, and a script that asks for
# a password to copy a build it just made is a script that gets run with sudo by reflex.

set -euo pipefail

readonly NAME="Waypoint"
readonly BUNDLE_ID="com.local.waypoint"
readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly STAGE_DIR="$ROOT/dist/$NAME-darwin-arm64"
readonly BUNDLE="$STAGE_DIR/$NAME.app"
# Where the bundle is installed. Overridable so a test harness can prove the install path
# without touching the copy the user launches, and so the whole pipeline can be rehearsed into a
# scratch directory.
readonly DEST="${WAYPOINT_APP_DEST:-${CANVAS_APP_DEST:-/Applications/$NAME.app}}"
readonly PLIST="$BUNDLE/Contents/Info.plist"
readonly BIN="Contents/MacOS/$NAME"

log()  { printf '[build-app] %s\n' "$*"; }
fail() { printf '[build-app] FAIL  %s\n' "$*" >&2; exit 1; }

cd "$ROOT"

# ---------------------------------------------------------------- 1. gates
if [[ "${SKIP_GATES:-0}" != "1" ]]; then
  log "gates: npm run check"
  npm run check
  log "gates: npm run smoke"
  npm run smoke
else
  log "gates skipped (SKIP_GATES=1)"
fi

# ------------------------------------------------------------- 2. package
if [[ "${SKIP_PACKAGE:-0}" != "1" ]]; then
  log "packaging"
  npm run package:mac
else
  log "packaging skipped (SKIP_PACKAGE=1): verifying the bundle already in dist/"
fi
[[ -d "$BUNDLE" ]] || fail "no bundle at $BUNDLE"

# -------------------------------------------------- 3. the bundle is complete
# main resolves every page, preload and data file relative to its own directory, so a missing
# entry here is a blank window plus a stderr line nobody sees. Checked before signing, so a
# broken build never gets a valid signature and never reaches /Applications.
for required in \
  "$BIN" \
  "Contents/Resources/app/package.json" \
  "Contents/Resources/app/dist/main/index.js" \
  "Contents/Resources/app/dist/main/blocklist.txt" \
  "Contents/Resources/app/dist/main/cosmetic.txt" \
  "Contents/Resources/app/dist/preload/canvas.js" \
  "Contents/Resources/app/dist/preload/overlay.js" \
  "Contents/Resources/app/dist/renderer/index.html" \
  "Contents/Resources/app/dist/renderer/overlay.html" \
  "Contents/Resources/app/dist/renderer/renderer.js" \
  "Contents/Resources/app/dist/renderer/overlay.js" \
  "Contents/Frameworks/Electron Framework.framework/Electron Framework"; do
  if [[ ! -e "$BUNDLE/$required" ]]; then
    fail "bundle is missing $required"
  fi
done

# And nothing that only exists for development: sources, tests, the packaging scripts and the
# repo's own history have no business inside a shipped app. Markdown is checked separately, because
# a bundle never needs a document — only the pages, the preloads and the two data lists.
for forbidden in \
  "Contents/Resources/app/src" \
  "Contents/Resources/app/tests" \
  "Contents/Resources/app/scripts" \
  "Contents/Resources/app/.git" \
  "Contents/Resources/app/.code-review-graph" \
  "Contents/Resources/app/node_modules"; do
  if [[ -e "$BUNDLE/$forbidden" ]]; then
    fail "bundle carries $forbidden"
  fi
done

for doc in "$BUNDLE/Contents/Resources/app"/*.md; do
  if [[ -e "$doc" ]]; then
    fail "bundle carries $(basename "$doc")"
  fi
done

# ------------------------------------------------------ 4. plist and binary
plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST" 2>/dev/null || printf ''
}

expect_plist() {
  local key="$1" want="$2" got
  got="$(plist_value "$key")"
  [[ "$got" == "$want" ]] || fail "Info.plist $key is '$got', expected '$want'"
  log "plist $key = $got"
}

expect_plist CFBundleIdentifier "$BUNDLE_ID"
expect_plist CFBundleName "$NAME"
expect_plist CFBundleDisplayName "$NAME"
expect_plist CFBundleExecutable "$NAME"

readonly ARCH_LINE="$(file -b "$BUNDLE/$BIN")"
case "$ARCH_LINE" in
  *arm64*) log "arch: $ARCH_LINE" ;;
  *) fail "binary is not arm64: $ARCH_LINE" ;;
esac

log "bundle size: $(du -sh "$BUNDLE" | cut -f1)"

# ------------------------------------------------------------- 5. signing
# Ad-hoc, and it has to happen *after* packaging: rewriting Info.plist invalidates the signature
# the Electron distribution arrived with, and an unsigned bundle is the "damaged" dialog.
log "signing ad-hoc"
codesign --force --deep --sign - "$BUNDLE"
codesign --verify --deep --strict --verbose=2 "$BUNDLE" 2>&1 | sed 's/^/    /'

# The signature's identifier has to be the bundle's, not the one the Electron distribution shipped
# with: `--verify` is happy either way, while a bundle whose code says `Identifier=Electron` and
# whose plist says otherwise is the kind of mismatch that breaks per-app permissions later.
readonly SIGN_ID="$(codesign -dv --verbose=4 "$BUNDLE" 2>&1 | awk -F= '/^Identifier=/{print $2}')"
[[ "$SIGN_ID" == "$BUNDLE_ID" ]] || fail "signature identifier is '$SIGN_ID', expected '$BUNDLE_ID'"
log "signature identifier: $SIGN_ID (adhoc)"

# ------------------------------------------- 6. the bundle actually runs
# The real assertion: this bundle runs its own smoke suite from inside its own Resources. It proves
# the preloads, pages, adblock lists and view lifecycle resolve under the packaged paths — and
# unlike `open -a` it does not put a window on the desktop or steal focus.
#
# This runs on the bundle in dist/, before it is installed, and that order is the point: an
# assertion that runs after the copy can only report a failure, it cannot prevent one. Measured
# 2026-11-02 — the edit checks went red on a good build and /Applications had already been
# overwritten with the unverified bundle, so the red run left the machine in the state it was
# warning about. rsync copies these bytes unchanged, and the installed copy is checked by
# `codesign --verify --deep --strict` afterwards.
if [[ "${SKIP_LAUNCH:-0}" != "1" ]]; then
  log "launch assertion: $BUNDLE, --smoke"
  LAUNCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cb-app-smoke.XXXXXX")"
  if WAYPOINT_SMOKE=1 WAYPOINT_CONFIG_DIR="$LAUNCH_DIR/config" \
    "$BUNDLE/$BIN" --smoke --user-data-dir="$LAUNCH_DIR/user-data" >"$LAUNCH_DIR/smoke.log" 2>&1; then
    log "bundled smoke: $(grep -c '^  PASS' "$LAUNCH_DIR/smoke.log") PASS, all checks passed"
    rm -rf "$LAUNCH_DIR"
  else
    tail -25 "$LAUNCH_DIR/smoke.log" | sed 's/^/    /'
    fail "the packaged app failed its own smoke suite — /Applications untouched, log kept at $LAUNCH_DIR/smoke.log"
  fi
else
  log "launch assertion skipped (SKIP_LAUNCH=1)"
fi

# ----------------------------------------------------------- 7. installing
if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  if pgrep -f "$DEST/Contents/MacOS" >/dev/null 2>&1; then
    fail "$NAME is running from $DEST — quit it and run again (this script will not kill your app)"
  fi
  [[ -w "/Applications" ]] || fail "/Applications is not writable by $(id -un), and this script does not use sudo"
  log "installing to $DEST"
  # A mirror of the bundle into its own path: stale files from a previous build go, and nothing
  # else in /Applications is ever in scope.
  rsync -a --delete "$BUNDLE/" "$DEST/"
  # rsync is not a signature tool: a copy is only trusted once the *installed* copy verifies.
  codesign --verify --deep --strict --verbose=2 "$DEST" 2>&1 | sed 's/^/    /'
  case "$(file -b "$DEST/$BIN")" in
    *arm64*) log "installed: $(du -sh "$DEST" | cut -f1) at $DEST" ;;
    *) fail "the installed binary is not arm64" ;;
  esac
else
  log "install skipped (SKIP_INSTALL=1)"
fi


log "done"
