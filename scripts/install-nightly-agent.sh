#!/usr/bin/env bash
# Install, inspect or remove the nightly maintenance LaunchAgent.
#
#   ./scripts/install-nightly-agent.sh --install            build/sign the helper, write the plist,
#                                                          print the two steps only a human can do
#   ./scripts/install-nightly-agent.sh --install --load      the above, then launchctl bootstrap
#   ./scripts/install-nightly-agent.sh --status              is it loaded, has it run, what does the
#                                                          log say, is the privacy grant in place
#   ./scripts/install-nightly-agent.sh --reload              bootout + bootstrap + run it now, and
#                                                          print what it did (use after editing the
#                                                          plist: launchd caches the definition)
#
# The job's stdout/stderr go to ~/Library/Logs/waypoint-nightly.log - not /tmp, which is
# cleared at reboot, and the run worth reading is usually the one before it.
#   ./scripts/install-nightly-agent.sh --uninstall           bootout + remove the plist
#   ./scripts/install-nightly-agent.sh --rebuild-helper      recompile and re-sign the helper
#                                                          (INVALIDATES the grant - see below)
#
# Why a helper app and not just `bash scripts/nightly-update.sh`: since macOS 26 a launchd-spawned
# bare interpreter has no "responsible app", so no privacy grant can apply to it and every read of
# an external volume fails with EPERM - while the identical script works in Terminal. The helper is
# a real app, so a Removable Volumes / Full Disk Access grant attaches to it and the child bash
# inherits it. (On a repo under $HOME the helper is unnecessary, but harmless.)
#
# The grant is bound to the helper's code signature. Compiling or signing it again (including
# --rebuild-helper, or a new compiler) silently invalidates the grant and the nightly starts failing
# with "Operation not permitted" again. Finalise scripts/nightly-helper.c BEFORE asking for the grant.

set -euo pipefail

readonly LABEL="com.local.waypoint.nightly"
readonly REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SCRIPT_PATH="$REPO/scripts/nightly-update.sh"
readonly HELPER_NAME="WaypointNightly"
readonly HELPER_APP="/Applications/$HELPER_NAME.app"
readonly HELPER_BIN="$HELPER_APP/Contents/MacOS/$HELPER_NAME"
readonly HELPER_ID="com.local.waypoint.nightly.helper"
readonly PLIST_SRC="$REPO/scripts/$LABEL.plist"
readonly PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
# launchd expands neither ~ nor $HOME, so the template carries a __LOG__ placeholder and the
# absolute path is built here. ~/Library/Logs survives reboots; /tmp does not.
readonly LOG="$HOME/Library/Logs/waypoint-nightly.log"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log()  { printf '[install-nightly] %s\n' "$*"; }
warn() { printf '[install-nightly] WARN %s\n' "$*" >&2; }
die()  { printf '[install-nightly] FAIL %s\n' "$1" >&2; exit "${2:-1}"; }

MODE=""
LOAD=0
REMOVE_HELPER=0
REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --install|--status|--uninstall|--reload) MODE="${arg#--}" ;;
    --load) LOAD=1 ;;
    --remove-helper) REMOVE_HELPER=1 ;;
    --rebuild-helper) REBUILD=1 ;;
    -h|--help) awk 'NR > 1 { if (/^#/) { sub(/^# ?/, ""); print; next } exit }' "$0"; exit 0 ;;
    *) die "unknown argument: $arg (try --help)" 64 ;;
  esac
done
[[ -n "$MODE" ]] || MODE="install"

build_helper() {
  [[ -x /usr/bin/clang ]] || die "clang not available; install the Command Line Tools" 78
  [[ -f "$REPO/scripts/nightly-helper.c" ]] || die "missing $REPO/scripts/nightly-helper.c" 78

  if [[ -x "$HELPER_BIN" ]] && (( ! REBUILD )); then
    log "helper already built at $HELPER_APP (use --rebuild-helper to replace it, which costs you the grant)"
    return 0
  fi

  if [[ -x "$HELPER_BIN" ]] && (( REBUILD )); then
    warn "rebuilding the helper RE-SIGNS it, which invalidates the privacy grant; re-grant afterwards"
  fi

  log "compiling $HELPER_NAME"
  mkdir -p "$HELPER_APP/Contents/MacOS"
  /usr/bin/clang -O2 -Wall -o "$HELPER_BIN" "$REPO/scripts/nightly-helper.c"

  cat >"$HELPER_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$HELPER_NAME</string>
  <key>CFBundleIdentifier</key><string>$HELPER_ID</string>
  <key>CFBundleName</key><string>$HELPER_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
PLIST

  log "signing ad-hoc (this is the signature the grant will be bound to)"
  /usr/bin/codesign --force --sign - --identifier "$HELPER_ID" "$HELPER_APP"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$HELPER_APP" || true
  log "helper ready: $HELPER_APP"
}

write_plist() {
  [[ -f "$PLIST_SRC" ]] || die "missing template $PLIST_SRC" 78
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  log "writing $PLIST_DST"
  sed -e "s|__HELPER_BIN__|$HELPER_BIN|g" \
      -e "s|__SCRIPT__|$SCRIPT_PATH|g" \
      -e "s|__REPO__|$REPO|g" \
      -e "s|__LOG__|$LOG|g" \
      "$PLIST_SRC" >"$PLIST_DST"
  /usr/bin/plutil -lint "$PLIST_DST" >/dev/null || die "rendered plist is not valid" 78
  # A placeholder that survived substitution is a job that will fail at 03:30 and nowhere else.
  # Match the three real placeholders only: a broad __[A-Z_]+__ pattern also hits prose in the
  # template's comments, which would fail an install that is actually correct.
  if grep -qE "__HELPER_BIN__|__SCRIPT__|__REPO__|__LOG__" "$PLIST_DST"; then
    die "unsubstituted placeholder left in $PLIST_DST" 78
  fi
}

loaded_stdout() {
  # launchd keeps the definition it read at load time and never re-reads the file, so the loaded
  # job can disagree with the plist on disk. That is how a log-path change silently fails to take.
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null |
    awk -F'= ' '/^[[:space:]]*stdout path = /{print $2; exit}'
}

tcc_rows() {
  # The user's own TCC.db is readable only by a process that already holds Full Disk Access, which
  # a terminal in this session may not. Absence of output is therefore "cannot say", not "no grant".
  local db="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
  [[ -r "$db" ]] || return 1
  /usr/bin/sqlite3 "$db" \
    "select service, auth_value, datetime(last_modified,'unixepoch','localtime') from access where client like '%waypoint%';" 2>/dev/null
}

case "$MODE" in
  install)
    [[ -d "$REPO" ]] || die "repo missing: $REPO (is its volume mounted?)" 78
    [[ -x "$SCRIPT_PATH" ]] || die "$SCRIPT_PATH is not executable (chmod +x)" 78

    build_helper
    write_plist

    cat <<NEXT

  Two steps are yours, because both are system policy and neither can be scripted honestly:

  1. Grant the helper access to the external volume, so a launchd run can read the repo:
       System Settings -> Privacy & Security -> Full Disk Access -> + -> Cmd-Shift-G ->
       /Applications -> $HELPER_NAME.app -> enable it.
       (The narrower service that actually gates /Volumes is Removable Volumes; if this Mac offers
       it, granting that instead is enough. Full Disk Access also works and is broader.)

  2. Load the job - from a plain Terminal, not from inside an agent shell or CI sandbox (those may
     refuse launchctl outright, and a job must not be able to restart its own supervisor):
       launchctl bootout gui/\$(id -u)/$LABEL 2>/dev/null
       launchctl bootstrap gui/\$(id -u) "$PLIST_DST"
       launchctl print gui/\$(id -u)/$LABEL | head -20

  Verify the grant works before trusting 03:30:
       "$HELPER_APP/Contents/MacOS/$HELPER_NAME" "$SCRIPT_PATH" --self-check
  That runs the nightly's environment probe inside the helper. Exit 0 with the version report = the
  grant is in place. "TCC refused access" = it is not.

  Then: ./scripts/install-nightly-agent.sh --status
NEXT

    if (( LOAD )); then
      log "loading the job"
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
      launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" || die "bootstrap failed (exit 5 usually means the label is disabled or already loaded)" 1
      launchctl print "gui/$(id -u)/$LABEL" | sed -n '1,20p'
    fi
    ;;

  reload)
    [[ -f "$PLIST_DST" ]] || die "no plist at $PLIST_DST (run --install first)" 78
    [[ -x "$SCRIPT_PATH" ]] || die "$SCRIPT_PATH is not executable" 78
    log "reloading $LABEL from $PLIST_DST"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || warn "nothing to boot out (was not loaded)"
    launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" ||
      die "bootstrap failed - check 'launchctl print gui/$(id -u)/$LABEL' and the plist's paths" 1
    log "loaded; running it now"
    launchctl kickstart "gui/$(id -u)/$LABEL" ||
      warn "kickstart failed; the job is loaded and will still run at its calendar time"
    # The job can take a few seconds (git, node, npm view); wait for it to finish rather than print
    # a log tail from before it wrote anything.
    for _ in $(seq 1 30); do
      [[ "$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/last exit code = /{print $0}')" == *"never exited"* ]] && sleep 1 || break
    done
    printf '\n'
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state =|runs =|last exit code|stdout path" | head -6
    printf '\n-- log tail (%s) --\n' "$LOG"
    tail -n 14 "$LOG" 2>/dev/null || warn "no log yet"
    ;;

  status)
    log "plist: $([[ -f "$PLIST_DST" ]] && echo present || echo MISSING)"
    log "helper: $([[ -x "$HELPER_BIN" ]] && echo "$HELPER_APP" || echo MISSING)"
    if [[ -x "$HELPER_BIN" ]]; then
      log "signature: $(/usr/bin/codesign -dv --verbose=4 "$HELPER_APP" 2>&1 | awk -F= '/^Identifier=/{print $2}' || echo unknown)"
    fi
    printf '\n-- launchctl --\n'
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|runs|last exit|program|stdout path|path =" | head -8 ||
      printf 'not loaded\n'
    if live="$(loaded_stdout)"; then
      if [[ "$live" != "$LOG" ]]; then
        printf '\nSTALE: the loaded job logs to %s but the plist says %s - launchd caches the\n' "$live" "$LOG"
        printf '       definition it read at load time. Run --reload to pick up the file.\n'
      fi
    fi
    printf '\n-- privacy grant --\n'
    if rows="$(tcc_rows)"; then
      if [[ -n "$rows" ]]; then printf '%s\n' "$rows"; else printf 'no rows for %s (not granted yet)\n' "$HELPER_ID"; fi
    else
      printf 'cannot read TCC.db from this context - check System Settings by hand\n'
    fi
    printf '\n-- last log lines (%s) --\n' "$LOG"
    if [[ -f "$LOG" ]]; then tail -n 15 "$LOG"; else printf 'no log yet\n'; fi
    ;;

  uninstall)
    log "removing the job"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || warn "bootout failed or the job was not loaded"
    if [[ -f "$PLIST_DST" ]]; then
      rm -f "$PLIST_DST"
      log "removed $PLIST_DST"
    fi
    if (( REMOVE_HELPER )); then
      rm -rf "$HELPER_APP"
      log "removed $HELPER_APP (the privacy grant it held is now a dead entry in System Settings)"
    else
      log "kept $HELPER_APP (pass --remove-helper to delete it)"
    fi
    ;;
esac
