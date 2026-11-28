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

MAX_DOWNLOAD_BYTES=209715200
MAX_DECOMPRESSED_BYTES=314572800
MAX_CHECKSUM_BYTES=4096

# Allow bounding caps lower only when running against a test release server.
if [ -n "${SWEEP_RELEASE_BASE_URL:-}" ]; then
  case "${SWEEP_TEST_MAX_DOWNLOAD_BYTES:-}" in
    ''|*[!0-9]*) ;;
    *) MAX_DOWNLOAD_BYTES="$SWEEP_TEST_MAX_DOWNLOAD_BYTES" ;;
  esac
  case "${SWEEP_TEST_MAX_DECOMPRESSED_BYTES:-}" in
    ''|*[!0-9]*) ;;
    *) MAX_DECOMPRESSED_BYTES="$SWEEP_TEST_MAX_DECOMPRESSED_BYTES" ;;
  esac
fi

info() { printf '  %s\n' "$*"; }
fail() { printf 'sweep-install: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"; }
need uname
need curl
need mktemp

fetch_checked() {
  fetch_url="$1"
  fetch_out="$2"
  fetch_max="$3"
  fetch_kind="$4"

  fetch_limit_plus_one=$((fetch_max + 1))
  curl_status_file="$stage_dir/curl.status"
  curl_headers_file="$stage_dir/curl.headers"
  rm -f "$curl_status_file" "$curl_headers_file" "$fetch_out"

  # Stream through `head -c $((fetch_max + 1))` in addition to `--max-filesize`
  # so curl < 8.4 cannot write an unbounded body when Content-Length is omitted.
  head_rc=0
  (
    rc=0
    curl --retry 3 --connect-timeout 15 --max-time 180 \
      --max-filesize "$fetch_max" -sS -L \
      -D "$curl_headers_file" \
      "$fetch_url" || rc=$?
    printf '%s' "$rc" > "$curl_status_file"
  ) | head -c "$fetch_limit_plus_one" > "$fetch_out" || head_rc=$?

  curl_rc="$(cat "$curl_status_file" 2>/dev/null || printf '1')"
  actual_bytes="$(wc -c < "$fetch_out" | tr -d '[:space:]')"
  if [ "$actual_bytes" -gt "$fetch_max" ]; then
    rm -f "$fetch_out"
    fail "${fetch_kind} failed (exceeds maximum allowed size of ${fetch_max} bytes): $fetch_url"
  fi

  if [ "$head_rc" -ne 0 ]; then
    rm -f "$fetch_out"
    fail "${fetch_kind} failed (write error; head exit $head_rc): $fetch_url"
  fi

  if [ "$curl_rc" -ne 0 ]; then
    rm -f "$fetch_out"
    case "$curl_rc" in
      23)
        fail "${fetch_kind} failed (write error; curl exit 23): $fetch_url"
        ;;
      63)
        fail "${fetch_kind} failed (exceeds maximum allowed size of ${fetch_max} bytes; curl exit 63): $fetch_url"
        ;;
      6|7|28|35|52|56)
        fail "${fetch_kind} failed (network error; curl exit $curl_rc): $fetch_url"
        ;;
      *)
        fail "${fetch_kind} failed (curl exit $curl_rc): $fetch_url"
        ;;
    esac
  fi

  http_code="$(awk '/^HTTP\// { code = $2 } END { print code }' "$curl_headers_file" 2>/dev/null || true)"
  case "$http_code" in
    2??) ;;
    404)
      rm -f "$fetch_out"
      fail "${fetch_kind} failed (HTTP 404: release asset missing for $label): $fetch_url"
      ;;
    *)
      rm -f "$fetch_out"
      fail "${fetch_kind} failed (HTTP ${http_code:-unknown}): $fetch_url"
      ;;
  esac
}

install_atomic() {
  src_path="$1"
  dst_path="$2"

  if [ -d "$dst_path" ]; then
    fail "destination path is a directory, refusing to install: $dst_path"
  fi

  # Prefer `mv -T` (GNU coreutils, BusyBox) for an exact-target rename(2) that
  # refuses directories and never moves into a directory or symlink-to-dir.
  probe_a="$stage_dir/.mv-probe-a"
  probe_b="$stage_dir/.mv-probe-b"
  : > "$probe_a"
  if mv -T -f "$probe_a" "$probe_b" 2>/dev/null; then
    rm -f "$probe_b"
    mv -T -f "$src_path" "$dst_path" || fail "failed to install sweep into $dst_path"
    return 0
  fi
  rm -f "$probe_a" "$probe_b"

  # On BSD/macOS where `mv -T` is unavailable, call exact rename(2) directly.
  if command -v perl >/dev/null 2>&1; then
    perl -e 'rename($ARGV[0], $ARGV[1]) or die "$!\n"' "$src_path" "$dst_path" \
      || fail "failed to install sweep into $dst_path"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os, sys; os.replace(sys.argv[1], sys.argv[2])' "$src_path" "$dst_path" \
      || fail "failed to install sweep into $dst_path"
    return 0
  fi

  # Last-resort fallback: refuse directory or symlink targets before moving.
  if [ -d "$dst_path" ] || [ -L "$dst_path" ]; then
    fail "destination path is a directory or symlink, refusing to install: $dst_path"
  fi
  mv -f "$src_path" "$dst_path" || fail "failed to install sweep into $dst_path"
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
  for loader in /lib/ld-musl-*.so.1 /usr/lib/ld-musl-*.so.1; do
    if [ -e "$loader" ]; then
      has_musl=1
      break
    fi
  done

  has_glibc=0
  for loader in \
    /lib/ld-linux*.so.* /lib64/ld-linux*.so.* /lib/*/ld-linux*.so.* \
    /usr/lib/ld-linux*.so.* /usr/lib64/ld-linux*.so.* /usr/lib/*/ld-linux*.so.*; do
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

if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
  fail "install directory path is not a directory: $INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR" || fail "cannot create install directory: $INSTALL_DIR"

dest_bin="$INSTALL_DIR/sweep"
if [ -d "$dest_bin" ]; then
  fail "destination path is a directory, refusing to install: $dest_bin"
fi
if [ -e "$dest_bin" ] && [ ! -f "$dest_bin" ] && [ ! -L "$dest_bin" ]; then
  fail "destination path is not a regular file, refusing to install: $dest_bin"
fi

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
fetch_checked "$url" "$download_path" "$MAX_DOWNLOAD_BYTES" "download"

# Verify the downloaded artifact against its published checksum before
# decompressing or executing anything.
fetch_checked "$url.sha256" "$checksum_path" "$MAX_CHECKSUM_BYTES" "checksum download"

actual="$(sha256_file "$download_path")"
expected="$(awk '{print tolower($1); exit}' "$checksum_path")"
case "$expected" in
  *[!0-9a-f]*|'') fail "invalid checksum file: $url.sha256" ;;
esac
[ "${#expected}" -eq 64 ] || fail "invalid checksum length in $url.sha256"
[ "$actual" = "$expected" ] || fail "checksum mismatch: expected $expected, got $actual"
info "checksum verified"

if [ "$use_gzip" -eq 1 ]; then
  limit_plus_one=$((MAX_DECOMPRESSED_BYTES + 1))
  gzip_status_file="$stage_dir/gzip.status"
  (
    rc=0
    gzip -dc "$download_path" || rc=$?
    printf '%s' "$rc" > "$gzip_status_file"
  ) | head -c "$limit_plus_one" > "$staged_bin"

  decompressed_bytes="$(wc -c < "$staged_bin" | tr -d '[:space:]')"
  if [ "$decompressed_bytes" -gt "$MAX_DECOMPRESSED_BYTES" ]; then
    fail "decompressed binary exceeds maximum allowed size (${MAX_DECOMPRESSED_BYTES} bytes)"
  fi

  gzip_rc="$(cat "$gzip_status_file" 2>/dev/null || printf '1')"
  if [ "$gzip_rc" -ne 0 ]; then
    fail "failed to decompress $download_asset (gzip exit $gzip_rc)"
  fi
else
  mv -f "$download_path" "$staged_bin"
fi

chmod 755 "$staged_bin" || fail "failed to mark staged binary executable"

# Prove the replacement executes on this host before touching any existing install.
if ! version_out="$("$staged_bin" --version 2>&1)"; then
  case "$version_out" in
    *libstdc++*|*libgcc*)
      fail "staged binary ($asset) failed --version (missing C++ runtime; on Alpine run: apk add libstdc++ libgcc); existing installation was left unchanged: $version_out"
      ;;
    *)
      fail "staged binary ($asset) failed --version; existing installation was left unchanged: $version_out"
      ;;
  esac
fi

install_atomic "$staged_bin" "$dest_bin"

info "installed sweep -> $dest_bin ($version_out)"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) info "note: $INSTALL_DIR is not on your PATH" ;;
esac
