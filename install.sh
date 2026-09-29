#!/usr/bin/env sh
# sweep installer — https://github.com/KitsuneKode/sweep
#   curl -fsSL https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.sh | sh
#
# Options (env):
#   SWEEP_VERSION      tag to install (default: latest release)
#   SWEEP_INSTALL_DIR  install prefix (default: ~/.local/bin)
set -eu

REPO="KitsuneKode/sweep"
INSTALL_DIR="${SWEEP_INSTALL_DIR:-$HOME/.local/bin}"

info() { printf '  %s\n' "$*"; }
fail() { printf 'sweep-install: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"; }
need uname
need curl

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os" in
  darwin) os="darwin" ;;
  linux)  os="linux" ;;
  *)      fail "unsupported OS: $os (use npm: npm i -g @kitsunekode/sweep)" ;;
esac
case "$arch" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) fail "unsupported arch: $arch" ;;
esac
asset="sweep-${os}-${arch}"

if [ -n "${SWEEP_VERSION:-}" ]; then
  tag="$SWEEP_VERSION"
  base="https://github.com/$REPO/releases/download/$tag"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

url="$base/$asset"
tmp="$(mktemp -d 2>/dev/null || mktemp -d -t sweep)"
trap 'rm -rf "$tmp"' EXIT

info "downloading $asset ${SWEEP_VERSION:-latest}"
curl -fsSL "$url" -o "$tmp/sweep" || fail "download failed: $url (release asset missing?)"

mkdir -p "$INSTALL_DIR"
mv "$tmp/sweep" "$INSTALL_DIR/sweep"
chmod +x "$INSTALL_DIR/sweep"

info "installed sweep → $INSTALL_DIR/sweep"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) info "note: $INSTALL_DIR is not on your PATH" ;;
esac

"$INSTALL_DIR/sweep" --version >/dev/null 2>&1 \
  && info "ok: $("$INSTALL_DIR/sweep" --version)" \
  || info "note: binary installed but did not run — check platform support"
