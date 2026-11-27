#!/usr/bin/env sh
# sweep installer - https://github.com/KitsuneKode/sweep
#   curl -fsSL https://raw.githubusercontent.com/KitsuneKode/sweep/main/install.sh | sh
#
# Options (env):
#   SWEEP_VERSION           version or tag to install, e.g. 0.5.2 or v0.5.2 (default: latest)
#   SWEEP_INSTALL_DIR       install prefix (default: ~/.local/bin)
#   SWEEP_LIBC              override Linux libc detection: glibc or musl (default: auto)
#   SWEEP_RELEASE_BASE_URL  test-only override for the GitHub releases base URL
set -eu

REPO="KitsuneKode/sweep"
INSTALL_DIR="${SWEEP_INSTALL_DIR:-$HOME/.local/bin}"
RELEASE_BASE="${SWEEP_RELEASE_BASE_URL:-https://github.com/$REPO/releases}"
RELEASE_BASE="${RELEASE_BASE%/}"

info() { printf '  %s\n' "$*"; }
fail() { printf 'sweep-install: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"; }
need uname
need curl
need mktemp

fetch() {
  curl --retry 3 --connect-timeout 15 -fsSL "$1" -o "$2"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print tolower($1)}'
  else
    fail "missing required tool: sha256sum or shasum"
  fi
}

detect_linux_libc() {
  if [ -n "${SWEEP_LIBC:-}" ]; then
    case "$SWEEP_LIBC" in
      glibc|musl) printf '%s' "$SWEEP_LIBC"; return 0 ;;
      *) fail "unsupported SWEEP_LIBC: $SWEEP_LIBC (expected glibc or musl)" ;;
    esac
  fi

  if command -v ldd >/dev/null 2>&1; then
    ldd_out="$(ldd --version 2>&1 || true)"
    case "$ldd_out" in
      *musl*|*MUSL*) printf 'musl'; return 0 ;;
      *glibc*|*GLIBC*|*"GNU libc"*|*"GNU C Library"*) printf 'glibc'; return 0 ;;
    esac
  fi

  has_musl=0
  for loader in /lib/ld-musl-*.so.1; do
    if [ -e "$loader" ]; then
      has_musl=1
      break
    fi
  done

  has_glibc=0
  for loader in /lib/ld-linux*.so.* /lib64/ld-linux*.so.* /lib/*/ld-linux*.so.*; do
    if [ -e "$loader" ]; then
      has_glibc=1
      break
    fi
  done

  if [ "$has_musl" -eq 1 ] && [ "$has_glibc" -eq 0 ]; then
    printf 'musl'
  else
    printf 'glibc'
  fi
}

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os" in
  darwin) os="darwin" ;;
  linux)  os="linux" ;;
  mingw*|msys*|cygwin*)
    fail "detected Windows shell ($os); use the PowerShell installer instead: irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex"
    ;;
  *)
    fail "unsupported OS: $os (use npm: npm i -g @kitsunekode/sweep)"
    ;;
esac

case "$arch" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) fail "unsupported arch: $arch" ;;
esac

if [ "$os" = "linux" ]; then
  libc="$(detect_linux_libc)"
  if [ "$libc" = "musl" ]; then
    asset="sweep-linux-${arch}-musl"
  else
    asset="sweep-linux-${arch}"
  fi
else
  asset="sweep-${os}-${arch}"
fi

if [ -n "${SWEEP_VERSION:-}" ]; then
  case "$SWEEP_VERSION" in
    *'/'*|*[[:space:]]*) fail "invalid SWEEP_VERSION: $SWEEP_VERSION" ;;
    v*) tag="$SWEEP_VERSION" ;;
    *)  tag="v$SWEEP_VERSION" ;;
  esac
  base="$RELEASE_BASE/download/$tag"
  label="$tag"
else
  base="$RELEASE_BASE/latest/download"
  label="latest"
fi

use_gzip=0
if command -v gzip >/dev/null 2>&1; then
  use_gzip=1
  download_asset="${asset}.gz"
else
  download_asset="$asset"
fi

mkdir -p "$INSTALL_DIR" || fail "cannot create install directory: $INSTALL_DIR"

# Stage exclusively inside INSTALL_DIR so verification runs on the target
# filesystem and the final rename is atomic without disturbing any existing
# sweep binary on failure.
stage_dir="$(mktemp -d "$INSTALL_DIR/.sweep-stage.XXXXXX")" || fail "failed to create staging directory in $INSTALL_DIR"
trap 'rm -rf "$stage_dir"' EXIT

download_path="$stage_dir/download"
checksum_path="$stage_dir/download.sha256"
staged_bin="$stage_dir/sweep"
url="$base/$download_asset"

info "downloading $download_asset ($label)"
fetch "$url" "$download_path" || fail "download failed: $url (release asset missing?)"

# Verify the downloaded artifact against its published checksum before
# decompressing or executing anything.
fetch "$url.sha256" "$checksum_path" || fail "checksum download failed: $url.sha256"

actual="$(sha256_file "$download_path")"
expected="$(awk '{print tolower($1); exit}' "$checksum_path")"
case "$expected" in
  *[!0-9a-f]*|'') fail "invalid checksum file: $url.sha256" ;;
esac
[ "${#expected}" -eq 64 ] || fail "invalid checksum length in $url.sha256"
[ "$actual" = "$expected" ] || fail "checksum mismatch: expected $expected, got $actual"
info "checksum verified"

if [ "$use_gzip" -eq 1 ]; then
  gzip -dc "$download_path" > "$staged_bin" || fail "failed to decompress $download_asset"
else
  mv -f "$download_path" "$staged_bin"
fi

chmod 755 "$staged_bin" || fail "failed to mark staged binary executable"

# Prove the replacement executes on this host before touching any existing install.
if ! version_out="$("$staged_bin" --version 2>&1)"; then
  fail "staged binary ($asset) failed --version; existing installation was left unchanged: $version_out"
fi

mv -f "$staged_bin" "$INSTALL_DIR/sweep" || fail "failed to install sweep into $INSTALL_DIR/sweep"

info "installed sweep -> $INSTALL_DIR/sweep ($version_out)"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) info "note: $INSTALL_DIR is not on your PATH" ;;
esac
