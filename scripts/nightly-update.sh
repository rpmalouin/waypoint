#!/usr/bin/env bash
# Nightly Electron maintenance for Waypoint.
#
#   ./scripts/nightly-update.sh              the real run (this is what the LaunchAgent starts)
#   ./scripts/nightly-update.sh --dry-run    report what it would do, change nothing
#   ./scripts/nightly-update.sh --self-check environment + version report, change nothing
#
# What it does, in this order, and why the order is not negotiable:
#
#   preflight -> clean-tree guard -> version check -> bump -> gates -> build and sign ->
#   commit -> install -> graph sync
#
# * Gates run before anything is installed: a version that fails the suite never reaches
#   /Applications.
# * The commit happens AFTER the build and BEFORE the install, so the repo never claims an Electron
#   version the installed app does not have, and the app is never replaced by an uncommitted build.
# * The bundle is built once. The second pass over `build-app.sh` reuses it (`SKIP_PACKAGE=1`),
#   because re-running the gates three times a night would make this pipeline the slowest thing on
#   the machine for no extra safety.
#
# Exit codes, because "failed" is not one thing:
#   0   up to date, or maintenance completed
#   1   a gate, the build, or the commit failed - the bump was reverted, the app is untouched
#   64  bad usage
#   75  the bump is committed and verified but the install did not happen (app running, or
#       /Applications not writable); re-run scripts/build-app.sh by hand
#   78  environment: repo/volume unreachable (including the launchd TCC gate), toolchain or
#       registry missing; nothing was attempted
#
# Env knobs:
#   TARGET_VERSION=<x.y.z>   use this version instead of asking the registry (testing, pinning)
#   ALLOW_MAJOR=1            accept a bump that changes the major version (default: report, skip)
#
# Logging: this script only writes to stdout/stderr. The LaunchAgent captures both into
# ~/Library/Logs/waypoint-nightly.log (StandardOutPath/StandardErrorPath in the plist), so
# there is exactly one writer and no duplicated lines. That path survives reboots, unlike /tmp.
# Run by hand, redirect it yourself:
#   ./scripts/nightly-update.sh 2>&1 | tee -a ~/Library/Logs/waypoint-nightly.log

set -euo pipefail

# The repo is derived from this script's own location, not hardcoded: a clone (or a rehearsal in
# /tmp) then operates on itself instead of on the working copy, and the LaunchAgent passes the path
# explicitly anyway.
readonly REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PLIST_LABEL="com.local.waypoint.nightly"

# launchd starts jobs with almost no environment. node and npm are Homebrew's, git and rsync are
# system: name them rather than inheriting whatever the caller had.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LC_ALL=C

DRY_RUN=0
SELF_CHECK=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --self-check) SELF_CHECK=1 ;;
    # Print the header comment block and stop at the first real line, so the help text cannot
    # drift out of step with the file the way a hardcoded line range does.
    -h|--help) awk 'NR > 1 { if (/^#/) { sub(/^# ?/, ""); print; next } exit }' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s (try --help)\n' "$arg" >&2; exit 64 ;;
  esac
done

step() { printf '\n[%s] == %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
note() { printf '[%s]    %s\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '[%s] WARN %s\n' "$(date '+%H:%M:%S')" "$*"; }
die()  { printf '[%s] FAIL %s\n' "$(date '+%H:%M:%S')" "$1"; exit "${2:-1}"; }

# ---------------------------------------------------------------- preflight
# Everything here fails *loudly and distinguishably*, because the interesting failure on this host
# is not "no upgrade" - it is "this process is not allowed to read the volume", and those two must
# never look alike in a log nobody is watching.

step "preflight"

# One check, two causes it must not confuse: an unmounted external volume and a TCC refusal both
# make the repo unreadable, and the message has to say which one it is.
[[ -d "$REPO" ]] || die "repo missing: $REPO (is the volume it lives on mounted?)" 78

probe="$(mktemp -t cb-nightly-probe)"
trap 'rm -f "$probe"' EXIT
if ! ls "$REPO" >/dev/null 2>"$probe"; then
  if grep -q "Operation not permitted" "$probe"; then
    die "TCC refused access to $REPO. This is not a mount problem: a launchd job running a bare interpreter has no privacy grant. Run this from the signed helper app (scripts/install-nightly-agent.sh --install) and grant it Removable Volumes." 78
  fi
  die "cannot read $REPO: $(tr '\n' ' ' <"$probe")" 78
fi

for tool in git npm node rsync codesign; do
  command -v "$tool" >/dev/null || die "missing tool: $tool (PATH=$PATH)" 78
done

cd "$REPO"
note "repo: $REPO at $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))"

# Duty cycle: two runs must never overlap (a slow smoke run can outlast the next cron-ish trigger).
lock="/tmp/waypoint-nightly.lock"
if ! mkdir "$lock" 2>/dev/null; then
  if [[ -n "$(find "$lock" -maxdepth 0 -mmin +180 2>/dev/null)" ]]; then
    warn "removing a stale lock older than 3 h"
    rm -rf "$lock"
    mkdir "$lock"
  else
    die "another nightly run holds $lock" 78
  fi
fi
trap 'rm -rf "$lock"; rm -f "$probe"' EXIT

# -------------------------------------------------------------- versions
step "versions"
current="$(node -p "require('./package.json').devDependencies.electron" | sed 's/^[~^]//')"
[[ -n "$current" ]] || die "cannot read the electron version from package.json" 78
note "installed: electron $current"

if [[ -n "${TARGET_VERSION:-}" ]]; then
  target="$TARGET_VERSION"
  note "target (pinned by TARGET_VERSION): $target"
else
  target="$(npm view electron version 2>/dev/null | tr -d '[:space:]')" ||
    die "cannot reach the npm registry for the latest electron version" 78
  [[ -n "$target" ]] || die "the registry returned an empty electron version" 78
  note "latest:    electron $target"
fi

major() { printf '%s' "${1%%.*}"; }

# A diagnostic must not refuse because the tree is dirty: the question --self-check answers is "can
# this environment run the job at all", and the interesting answers are the volume, the toolchain and
# the version pair. The clean-tree rule belongs to a run that would change something.
if (( SELF_CHECK )); then
  step "self-check"
  dirty="$(git status --porcelain)"
  if [[ -n "$dirty" ]]; then
    note "working tree is DIRTY (a real run would abort):"
    printf '%s\n' "$dirty" | sed 's/^/           /'
  else
    note "working tree is clean"
  fi
  note "electron installed=$current target=$target"
  if [[ "$target" == "$current" ]]; then
    note "nothing to do: already current"
  elif [[ "$(major "$target")" != "$(major "$current")" ]]; then
    note "a MAJOR upgrade is available; a run would skip it unless ALLOW_MAJOR=1"
  else
    note "a run would bump $current -> $target"
  fi
  note "log destination (LaunchAgent): $HOME/Library/Logs/waypoint-nightly.log"
  exit 0
fi

if [[ "$target" == "$current" ]]; then
  step "nothing to do"
  note "electron $current is already the target version"
  printf 'NIGHTLY_OK up-to-date electron=%s\n' "$current"
  exit 0
fi

# ------------------------------------------------------------ clean tree
step "working tree"
dirty="$(git status --porcelain)"
if [[ -n "$dirty" ]]; then
  printf '%s\n' "$dirty" | sed 's/^/           /'
  die "working tree is dirty; a nightly bump must start from a committed tree" 1
fi
note "clean"

if [[ "$(major "$target")" != "$(major "$current")" ]] && [[ "${ALLOW_MAJOR:-0}" != "1" ]]; then
  step "major version available - skipped"
  note "electron $target is a major upgrade from $current; this pipeline only takes minor and patch"
  note "bumps unattended. Run it deliberately with ALLOW_MAJOR=1 (and expect to watch it)."
  printf 'NIGHTLY_SKIPPED major-available from=%s to=%s\n' "$current" "$target"
  exit 0
fi

if (( DRY_RUN )); then
  step "dry run - nothing will change"
  note "would run: npm install --save-dev electron@$target"
  note "would run: npm run check && npm run smoke"
  note "would run: SKIP_GATES=1 SKIP_INSTALL=1 ./scripts/build-app.sh"
  note "would commit: chore(deps): bump electron to $target (Chromium upgrade) [automated]"
  note "would run: SKIP_GATES=1 SKIP_PACKAGE=1 SKIP_LAUNCH=1 ./scripts/build-app.sh   (install)"
  note "would rebuild the code graph"
  exit 0
fi

# ------------------------------------------------------------------ bump
step "bumping electron $current -> $target"
# --save-exact, deliberately: the repo pins electron exactly (not `^x.y.z`), because a caret here
# lets any later `npm install` drift the runtime the app was tested against. npm's default is the
# caret, and a nightly that quietly widened the pin would undo the packaging work's whole premise.
npm install --save-dev --save-exact --no-audit --no-fund "electron@$target"
installed="$(node -p "require('./node_modules/electron/package.json').version")"
[[ "$installed" == "$target" ]] || die "npm installed electron $installed, expected $target" 78
declared="$(node -p "require('./package.json').devDependencies.electron")"
[[ "$declared" == "$target" ]] ||
  die "package.json declares electron '$declared', expected the exact pin '$target'" 78
note "installed: electron $installed (pinned exactly as \"$declared\")"

# The revert is deliberately two files, not `git checkout -- .`: a long gate run is a long window,
# and this repo can be edited by a human while the nightly is working. Only what this script touched
# is ever thrown away.
revert() {
  local reason="$1"
  step "reverting the bump ($reason)"
  git checkout -- package.json package-lock.json
  note "package.json and package-lock.json restored; $(git status --porcelain | wc -l | tr -d ' ') path(s) still changed"
  note "the installed app in /Applications was not touched"
}

# npm can install the `electron` package WITHOUT its binary: whether a postinstall runs is a policy
# question (npm 11's install-scripts allowlist), and the result is an electron shim with no dist/ -
# which does not fail here, it fails much later at `npm run smoke` with a confusing error, or worse,
# at the packaged app's launch assertion. So the binary is proven present and, if it is not, the
# package's own installer is run - the exact script its postinstall would have run.
ensure_electron_binary() {
  if [[ -f node_modules/electron/path.txt && -d node_modules/electron/dist/Electron.app ]]; then
    note "electron binary present ($(node -p "require('./node_modules/electron/package.json').version"))"
    return 0
  fi
  warn "the electron package installed without its binary; running node_modules/electron/install.js"
  node node_modules/electron/install.js
  [[ -f node_modules/electron/path.txt && -d node_modules/electron/dist/Electron.app ]]
}

if ! ensure_electron_binary; then
  revert "the electron binary did not install"
  printf 'NIGHTLY_FAILED binary from=%s to=%s\n' "$current" "$target"
  exit 1
fi

# ----------------------------------------------------------------- gates
run_gate() {  # run_gate <label> <command...>
  local label="$1"; shift
  step "gate: $label"
  local rc=0
  "$@" || rc=$?
  if (( rc != 0 )); then
    note "gate $label FAILED (rc=$rc)"
    return "$rc"
  fi
  note "gate $label passed"
}

if ! run_gate "check" npm run check; then
  revert "npm run check failed"
  printf 'NIGHTLY_FAILED gate=check from=%s to=%s\n' "$current" "$target"
  exit 1
fi

if ! run_gate "smoke" npm run smoke; then
  revert "npm run smoke failed"
  printf 'NIGHTLY_FAILED gate=smoke from=%s to=%s\n' "$current" "$target"
  exit 1
fi

# --------------------------------------------------------- build and sign
# Gates are skipped here on purpose: they just ran against this exact tree, and build-app.sh would
# otherwise repeat both of them (plus its own bundled smoke) for the third time tonight. The bundle
# is built, verified, signed and smoke-run inside the bundle; it is NOT installed yet.
step "building the bundle"
if ! SKIP_GATES=1 SKIP_INSTALL=1 ./scripts/build-app.sh; then
  revert "bundle build failed"
  printf 'NIGHTLY_FAILED build from=%s to=%s\n' "$current" "$target"
  exit 1
fi

# ---------------------------------------------------------------- commit
step "committing the bump"
# A machine-written commit must carry exactly the two files this script changed. If anything else
# appeared while the gates were running, that is a human's work and it is not getting swept in.
unexpected="$(git status --porcelain | grep -v -E '^ M package(-lock)?\.json$' || true)"
if [[ -n "$unexpected" ]]; then
  printf '%s\n' "$unexpected" | sed 's/^/           /'
  revert "unexpected changes appeared during the run"
  printf 'NIGHTLY_FAILED commit=unexpected-changes from=%s to=%s\n' "$current" "$target"
  exit 1
fi

git add package.json package-lock.json
if ! git commit -q \
  -m "chore(deps): bump electron to $target (Chromium upgrade) [automated]" \
  -m "Nightly maintenance: electron $current -> $target. npm run check and npm run smoke passed on
this tree, and the bundle built from it passed its own bundled smoke suite before this commit.
Two files only, both dependency metadata; nothing under src/ changed.

Automated by scripts/nightly-update.sh (LaunchAgent $PLIST_LABEL, daily 03:30)."; then
  revert "git commit failed"
  printf 'NIGHTLY_FAILED commit from=%s to=%s\n' "$current" "$target"
  exit 1
fi
note "committed $(git rev-parse --short HEAD)"

# -------------------------------------------------------------- install
# The bundle in dist/ is the one that was just built, signed and smoke-run, so the second pass only
# re-verifies, installs and re-checks the signature. If the app is open, build-app.sh refuses by
# design (it will not kill your windows) - the bump stays committed and verified, and the log says
# exactly what to do.
step "installing"
if ! SKIP_GATES=1 SKIP_PACKAGE=1 SKIP_LAUNCH=1 ./scripts/build-app.sh; then
  note "the bump is committed and the bundle is verified, but /Applications was not updated"
  printf 'NIGHTLY_FAILED install from=%s to=%s (committed, not installed)\n' "$current" "$target"
  exit 75
fi

# ----------------------------------------------------------- graph sync
# A convenience, never a gate: the interpreter is discovered rather than pinned, so a machine that
# has the graph tool in a per-user venv keeps working and one that has never heard of it prints a
# warning and still exits 0. Set CRG_PYTHON to point at the interpreter explicitly.
step "code graph"
CRG_PY="${CRG_PYTHON:-}"
if [[ -z "$CRG_PY" && -x "$HOME/.local/venvs/crg/bin/python3" ]]; then
  CRG_PY="$HOME/.local/venvs/crg/bin/python3"
fi
if [[ -z "$CRG_PY" ]]; then
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import code_review_graph' >/dev/null 2>&1; then
      CRG_PY="$(command -v "$candidate")"
      break
    fi
  done
fi
if [[ -n "$CRG_PY" ]] && "$CRG_PY" -c 'import code_review_graph' >/dev/null 2>&1; then
  if "$CRG_PY" -m code_review_graph build --repo "$REPO" >/dev/null 2>&1; then
    note "graph rebuilt at $(git rev-parse --short HEAD)"
  else
    warn "graph rebuild failed; not fatal (the graph is a convenience, the commit is the record)"
  fi
else
  warn "no code-graph CLI found (set CRG_PYTHON to a python that can import code_review_graph); skipped"
fi

step "done"
printf 'NIGHTLY_OK bumped from=%s to=%s commit=%s\n' "$current" "$target" "$(git rev-parse --short HEAD)"
