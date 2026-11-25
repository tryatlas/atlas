#!/usr/bin/env bash
# Compare the Linux builds on this machine with the ones CI released, to find
# out why a CI package misbehaves when a local build does not.
#
# CI builds on Ubuntu 22.04 (release-linux.yml). The deb, rpm and Arch package
# link the user's own WebKitGTK at runtime; the AppImage carries the build
# host's WebKitGTK, GTK and GLib inside it. The CI deb and the CI AppImage hold
# the same binary, so running both on this machine separates the two causes:
#
#   bug in ci-appimage only      → the bundled (old) libraries
#   bug in ci-deb too            → the code or the 22.04 build itself; build on
#                                  22.04 locally to confirm (distrobox-build.sh)
#   bug in ci-deb, not in local  → compare versions: is it the same commit?
#
# Usage:
#   scripts/linux-compare-builds.sh [report] [--tag alpha-X.Y.Z]
#   scripts/linux-compare-builds.sh run <build> [--tag alpha-X.Y.Z]
#
# Builds:  installed       /usr/bin/atl, the installed package
#          local           target/release/atlas
#          local-appimage  the newest AppImage under target/release/bundle/appimage
#          ci-deb          the CI deb's binary, run in place against this system's libraries
#          ci-appimage     the CI AppImage, with its bundled libraries
#
# The tag defaults to the latest GitHub release. Downloads and extractions go
# to target/linux-compare/<tag>/ and are reused. `run` logs to
# target/linux-compare/<build>.log.
#
# Every release build shares one profile (dev.atlas.ide) and one instance
# lock: with any release Atlas open, `run` would only focus that window, so it
# refuses. Quit Atlas and run this from an outside terminal, not Atlas's own.
#
# Not under scripts/linux/: a pull request touching that directory dry-runs
# the whole release (release-linux.yml), and this script ships nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/target/linux-compare"

MODE=report
BUILD=""
TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    report) MODE=report ;;
    run) MODE=run; BUILD="${2:-}"; shift ;;
    --tag) TAG="${2:-}"; shift ;;
    -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

case "$(uname -m)" in
  x86_64) DEB_ARCH=amd64; APPIMAGE_ARCH=amd64; LIBDIR=/usr/lib/x86_64-linux-gnu ;;
  aarch64) DEB_ARCH=arm64; APPIMAGE_ARCH=aarch64; LIBDIR=/usr/lib/aarch64-linux-gnu ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 2 ;;
esac

declare -A SEEN=()   # build id → the first build shown with it

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
row() { printf '  %-22s %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------ fetch ---
fetch_ci() {
  have gh || { echo "gh is required to download the CI release" >&2; exit 1; }
  if [ -z "$TAG" ]; then
    TAG="$(gh release view --json tagName -q .tagName)"
  fi
  DIR="$CACHE/$TAG"
  mkdir -p "$DIR"
  local ver="${TAG#alpha-}"
  CI_DEB="$DIR/tryatlas_${ver}_${DEB_ARCH}.deb"
  CI_APPIMAGE="$DIR/tryatlas_${ver}_${APPIMAGE_ARCH}.AppImage"
  for f in "$CI_DEB" "$CI_APPIMAGE"; do
    if [ ! -s "$f" ]; then
      echo "downloading $(basename "$f") from $TAG…" >&2
      gh release download "$TAG" -p "$(basename "$f")" -D "$DIR" --clobber
    fi
  done
  chmod +x "$CI_APPIMAGE"

  CI_DEB_ROOT="$DIR/deb-root"
  if [ ! -x "$CI_DEB_ROOT/usr/bin/atl" ]; then
    rm -rf "$CI_DEB_ROOT"
    dpkg-deb -x "$CI_DEB" "$CI_DEB_ROOT"
  fi
  CI_APPDIR="$DIR/squashfs-root"
  if [ ! -d "$CI_APPDIR" ]; then
    (cd "$DIR" && "$CI_APPIMAGE" --appimage-extract >/dev/null)
  fi
}

local_appimage() {
  ls -t "$ROOT"/target/release/bundle/appimage/*.AppImage 2>/dev/null | head -n 1 || true
}

# ----------------------------------------------------------------- probes ---
# The WebKitGTK version a library reports, loaded beside its own siblings.
webkit_version() {
  local lib="$1"
  [ -e "$lib" ] || { echo "-"; return; }
  have python3 || { echo "? (needs python3)"; return; }
  # The env goes on python alone: on `timeout` too, it would load the
  # bundle's older libsystemd and refuse to start.
  timeout 20 env LD_LIBRARY_PATH="$(dirname "$lib")" python3 -I -c '
import ctypes, sys
l = ctypes.CDLL(sys.argv[1])
print("%d.%d.%d" % (l.webkit_get_major_version(), l.webkit_get_minor_version(), l.webkit_get_micro_version()))
' "$lib" 2>/dev/null || echo "? (failed to load)"
}

glibc_floor() {
  objdump -T "$1" 2>/dev/null | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -t. -k2 -n -u | tail -n 1 | sed 's/GLIBC_//'
}

build_id() {
  readelf -n "$1" 2>/dev/null | awk '/Build ID/ {print $3}' | cut -c1-16
}

has_posthog_key() {
  if grep -aqE 'phc_[A-Za-z0-9]{20,}' "$1"; then echo yes; else echo no; fi
}

describe_binary() {
  local name="$1" bin="$2" version="$3" webkit="$4"
  bold "$name"
  if [ ! -e "$bin" ]; then
    row "binary" "not found ($bin)"
    return
  fi
  row "binary" "$bin"
  row "version" "$version"
  row "built" "$(date -r "$bin" '+%Y-%m-%d %H:%M')"
  row "size" "$(stat -c %s "$bin") bytes"
  local id
  id="$(build_id "$bin")"
  row "build id" "$id${SEEN[$id]:+  (same binary as ${SEEN[$id]})}"
  [ -n "$id" ] && [ -z "${SEEN[$id]:-}" ] && SEEN[$id]="${name%% *}"
  row "glibc floor" "$(glibc_floor "$bin")"
  row "PostHog key embedded" "$(has_posthog_key "$bin")"
  row "WebKitGTK used" "$webkit"
}

# ----------------------------------------------------------------- report ---
report() {
  fetch_ci

  bold "This machine"
  . /etc/os-release
  row "distro" "$PRETTY_NAME"
  row "kernel" "$(uname -r)"
  row "glibc" "$(ldd --version | head -n 1 | grep -oE '[0-9]+\.[0-9]+$')"
  row "session" "${XDG_SESSION_TYPE:-?} (${XDG_CURRENT_DESKTOP:-?})"
  if have lspci; then
    row "GPU" "$(lspci | grep -iE 'vga|3d|display' | head -n 1 | cut -d: -f3- | sed 's/^ //')"
  fi
  SYS_WEBKIT="$(webkit_version "$LIBDIR/libwebkit2gtk-4.1.so.0")"
  row "system WebKitGTK" "$SYS_WEBKIT"

  local installed_ver="not installed"
  if have dpkg-query && dpkg-query -W -f='${Version}' tryatlas >/dev/null 2>&1; then
    installed_ver="$(dpkg-query -W -f='${Version}' tryatlas) (deb)"
  elif have rpm && rpm -q tryatlas >/dev/null 2>&1; then
    installed_ver="$(rpm -q --qf '%{VERSION}' tryatlas) (rpm)"
  fi
  describe_binary "installed  (/usr/bin/atl)" "$(readlink -f /usr/bin/atl 2>/dev/null || echo /usr/bin/atl)" \
    "$installed_ver" "$SYS_WEBKIT (system)"

  local src_ver
  src_ver="$(grep -m1 '^version' "$ROOT/src-tauri/Cargo.toml" | cut -d'"' -f2)"
  describe_binary "local  (target/release/atlas)" "$ROOT/target/release/atlas" \
    "unknown; the source is $src_ver now, the binary may predate it (see built, build id)" \
    "$SYS_WEBKIT (system)"

  local lai
  lai="$(local_appimage)"
  local lai_dir="$ROOT/target/release/bundle/appimage/Atlas.AppDir"
  describe_binary "local-appimage  (${lai:+$(basename "$lai")})" "$lai_dir/usr/bin/atlas" \
    "$(basename "${lai:-?}")" "$(webkit_version "$lai_dir/usr/lib/libwebkit2gtk-4.1.so.0") (bundled)"

  describe_binary "ci-deb  ($TAG)" "$CI_DEB_ROOT/usr/bin/atl" \
    "$(dpkg-deb -f "$CI_DEB" Version)" "$SYS_WEBKIT (system)"

  local ci_webkit
  ci_webkit="$(webkit_version "$CI_APPDIR/usr/lib/libwebkit2gtk-4.1.so.0")"
  describe_binary "ci-appimage  ($TAG)" "$CI_APPDIR/usr/bin/atlas" \
    "$(basename "$CI_APPIMAGE")" "$ci_webkit (bundled)"

  bold "What differs"
  if [ "$(build_id "$CI_DEB_ROOT/usr/bin/atl")" = "$(build_id "$CI_APPDIR/usr/bin/atlas")" ]; then
    row "ci-deb vs ci-appimage" "same binary; only the libraries differ"
  else
    row "ci-deb vs ci-appimage" "different binaries (unexpected)"
  fi
  if [ "$ci_webkit" != "$SYS_WEBKIT" ]; then
    row "WebKitGTK" "CI AppImage $ci_webkit, this system $SYS_WEBKIT"
  fi
  if [ -e /usr/bin/atl ] && [ "${installed_ver%% *}" != "$(dpkg-deb -f "$CI_DEB" Version)" ]; then
    row "installed vs CI" "${installed_ver%% *} vs $(dpkg-deb -f "$CI_DEB" Version): different code"
  fi

  bold "Next"
  echo "  Reproduce the bug in each, one at a time, with every Atlas window closed:"
  echo "    $0 run ci-deb       ${TAG:+--tag $TAG}"
  echo "    $0 run ci-appimage  ${TAG:+--tag $TAG}"
  echo "    $0 run local"
  echo "  Bug only in ci-appimage → bundled libraries. Bug in ci-deb too → build on"
  echo "  22.04 locally (DISTROBOX_IMAGE=docker.io/library/ubuntu:22.04 scripts/distrobox-build.sh)."
}

# -------------------------------------------------------------------- run ---
run_build() {
  local cmd=()
  case "$BUILD" in
    installed) cmd=(/usr/bin/atl) ;;
    local) cmd=("$ROOT/target/release/atlas") ;;
    local-appimage)
      local lai
      lai="$(local_appimage)"
      [ -n "$lai" ] || { echo "no local AppImage under target/release/bundle/appimage" >&2; exit 1; }
      cmd=("$lai") ;;
    ci-deb) fetch_ci; cmd=("$CI_DEB_ROOT/usr/bin/atl") ;;
    ci-appimage) fetch_ci; cmd=("$CI_APPIMAGE") ;;
    *) echo "run needs a build: installed | local | local-appimage | ci-deb | ci-appimage" >&2; exit 2 ;;
  esac
  [ -x "${cmd[0]}" ] || { echo "not found: ${cmd[0]}" >&2; exit 1; }

  # Release builds take the single-instance lock: a second one only focuses
  # the first. Dev builds (`bun run dev:app`) are a separate profile and fine.
  local running
  # Main processes only: they run with no arguments, its helpers (mcp-bridge…)
  # with some. An AppImage's runs as /tmp/.mount_*/usr/bin/atlas.
  running="$(pgrep -u "$USER" -a -f '(/usr/bin/atl|/usr/bin/tryatlas|/release/atlas|/usr/bin/atlas)$' || true)"
  if [ -n "$running" ]; then
    echo "A release Atlas is already running; the new one would only focus it:" >&2
    echo "$running" | sed 's/^/  /' >&2
    echo "Quit it (and run this from an outside terminal), then try again." >&2
    exit 1
  fi

  mkdir -p "$CACHE"
  local log="$CACHE/$BUILD.log"
  echo "running $BUILD: ${cmd[*]}"
  echo "stdout/stderr → $log"
  echo "Atlas's own log → ~/.local/share/dev.atlas.ide/logs/"
  "${cmd[@]}" 2>&1 | tee "$log"
}

case "$MODE" in
  report) report ;;
  run) run_build ;;
esac
