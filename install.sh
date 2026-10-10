#!/bin/sh
# Install Triage.app — a native macOS window over the local triage daemon.
#
#   curl -fsSL https://usetriage.sh/install.sh | sh
#
# Environment:
#   TRIAGE_VERSION      version to install (default: the latest GitHub release)
#   TRIAGE_APP_ZIP      install this local zip instead of downloading one
#   TRIAGE_INSTALL_DIR  where Triage.app goes (default: /Applications, else ~/Applications)
#   TRIAGE_NO_OPEN=1    don't open the app when done
#
# Everything lives in main(), called on the last line, so a download cut short
# by the network runs nothing.

set -eu

REPO="usetriage/triage"
APP="Triage.app"
BUNDLE_ID="sh.usetriage.app"
# Ours too: the Chrome-shim app `triage app install` wrote, before and after the rename.
KNOWN_IDS="sh.usetriage.app com.heytriage.app"

if [ -t 1 ]; then
  ESC=$(printf '\033')
  BOLD="${ESC}[1m" DIM="${ESC}[2m" GREEN="${ESC}[32m" RED="${ESC}[31m" RESET="${ESC}[0m"
else
  BOLD="" DIM="" GREEN="" RED="" RESET=""
fi

step() { printf '  %s›%s %s\n' "$DIM" "$RESET" "$1"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
die() {
  printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2
  exit 1
}

TMP=""
cleanup() { if [ -n "$TMP" ]; then rm -rf "$TMP"; fi; }

detect_arch() {
  case "$(uname -m)" in
    arm64) echo arm64 ;;
    x86_64)
      # A shell under Rosetta reports x86_64 on Apple silicon.
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
        echo arm64
      else
        echo x64
      fi
      ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

latest_version() {
  curl -fsSL -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' |
    head -n 1
}

bundle_id() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true
}

is_ours() {
  case " $KNOWN_IDS " in *" $1 "*) return 0 ;; esac
  return 1
}

# `is running` asks without launching; an id Launch Services doesn't know is "false".
is_running() {
  [ "$(osascript -e "application id \"$1\" is running" 2>/dev/null || echo false)" = true ]
}

# The version of a triage daemon running out of $1 (a bundle path), if any.
# Quitting the app leaves its daemon up, still running the old bundle's code.
daemon_inside() {
  health=$(curl -fsS -m 2 "http://localhost:${TRIAGE_APP_PORT:-5178}/api/health" 2>/dev/null) || return 0
  pid=$(printf '%s' "$health" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
  [ -n "$pid" ] || return 0
  case "$(ps -o command= -p "$pid" 2>/dev/null)" in
    *"$1/"*) printf '%s' "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' ;;
  esac
}

quit_app() {
  is_running "$1" || return 0
  step "quitting the running Triage"
  osascript -e "tell application id \"$1\" to quit" >/dev/null 2>&1 || true
  i=0
  while is_running "$1"; do
    i=$((i + 1))
    [ "$i" -gt 20 ] && die "Triage is still running — quit it, then run this again"
    sleep 0.5
  done
}

main() {
  [ "$(uname -s)" = Darwin ] || die "Triage.app is macOS only — on Linux, run: npm i -g usetriage"
  major=$(sw_vers -productVersion | cut -d. -f1)
  [ "$major" -ge 12 ] || die "Triage.app needs macOS 12 or newer"

  printf '\n  %striage%s %sfor macOS%s\n\n' "$BOLD" "$RESET" "$DIM" "$RESET"

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/triage-install.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  zip="$TMP/Triage.zip"
  if [ -n "${TRIAGE_APP_ZIP:-}" ]; then
    [ -f "$TRIAGE_APP_ZIP" ] || die "no such file: $TRIAGE_APP_ZIP"
    cp "$TRIAGE_APP_ZIP" "$zip"
    ok "using $TRIAGE_APP_ZIP"
  else
    arch=$(detect_arch)
    version="${TRIAGE_VERSION:-}"
    version="${version#v}"
    if [ -z "$version" ]; then
      version=$(latest_version)
      [ -n "$version" ] || die "couldn't find the latest release — set TRIAGE_VERSION=x.y.z and retry"
    fi
    asset="Triage-$version-mac-$arch.zip"
    url="https://github.com/$REPO/releases/download/v$version/$asset"
    step "downloading $asset"
    if [ -t 2 ]; then progress=--progress-bar; else progress=-sS; fi
    curl -fL "$progress" --retry 2 -o "$zip" "$url" ||
      die "download failed: $url
    (a release's app can take ~15 min to appear after the tag — retry, or pin TRIAGE_VERSION)"
    ok "downloaded v$version ($arch)"
  fi

  # Unpack and check it before touching what's installed.
  ditto -x -k "$zip" "$TMP/unpacked" || die "not a zip archive"
  new="$TMP/unpacked/$APP"
  [ -d "$new" ] || die "the archive has no $APP at its top level"
  [ "$(bundle_id "$new")" = "$BUNDLE_ID" ] || die "$APP in the archive isn't $BUNDLE_ID"
  xattr -dr com.apple.quarantine "$new" 2>/dev/null || true
  codesign --verify --deep --strict "$new" 2>/dev/null || die "$APP failed its signature check"
  ok "signature verified"

  if [ -n "${TRIAGE_INSTALL_DIR:-}" ]; then
    dir="$TRIAGE_INSTALL_DIR"
  elif [ -w /Applications ]; then
    dir=/Applications
  else
    dir="$HOME/Applications"
  fi
  mkdir -p "$dir" || die "can't create $dir"
  [ -w "$dir" ] || die "$dir isn't writable — set TRIAGE_INSTALL_DIR"
  dest="$dir/$APP"

  quit_app "$BUNDLE_ID"
  stale=""
  if [ -e "$dest" ]; then
    stale=$(daemon_inside "$dest")
    old=$(bundle_id "$dest")
    is_ours "$old" || die "$dest is another app (${old:-no bundle id}) — move it aside or set TRIAGE_INSTALL_DIR"
    [ "$old" = "$BUNDLE_ID" ] || quit_app "$old"
    rm -rf "$dest" || die "couldn't remove the old $dest"
    ok "replaced $dest"
  else
    ok "installed $dest"
  fi
  mv "$new" "$dest"

  # A second copy with the same bundle id (e.g. the old `triage app install`
  # shim in the other Applications folder) would make Launch Services pick
  # either one. Only the default locations are checked.
  if [ -z "${TRIAGE_INSTALL_DIR:-}" ]; then
    for other in "/Applications/$APP" "$HOME/Applications/$APP"; do
      [ "$other" = "$dest" ] && continue
      if [ -d "$other" ] && is_ours "$(bundle_id "$other")"; then
        rm -rf "$other" 2>/dev/null && ok "removed the older copy at $other"
      fi
    done
  fi

  if [ "${TRIAGE_NO_OPEN:-}" != 1 ]; then
    open "$dest"
    ok "opened Triage"
  fi
  if [ -n "$stale" ]; then
    printf '  %s!%s triage %s is still running from the old app — when no session is busy,\n' "$BOLD" "$RESET" "$stale"
    printf '    choose %sTriage › Restart triage server…%s to switch to the new one\n' "$BOLD" "$RESET"
  fi

  cat <<EOF

  ${BOLD}Triage is installed.${RESET}

  It opens a window on the triage daemon on this Mac — the one already
  running, or one it starts for you on port 5178. Quitting the app leaves
  triage running, so live sessions and watches keep going.

  Needs Claude Code installed and logged in: ${DIM}https://claude.com/claude-code${RESET}

EOF
}

main "$@"
