#!/usr/bin/env bash
# Render this package for a released version: pkgver, pkgrel and checksums in
# PKGBUILD, then .SRCINFO from the PKGBUILD itself (makepkg's format, so it
# runs where makepkg does not, such as an Ubuntu CI runner).
#
#   packaging/aur/sweep-cli-bin/update.sh 0.5.2
#
set -euo pipefail

version="${1:?usage: update.sh <version>}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a release version: $version" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
repo="KitsuneKode/sweep"
release="https://github.com/${repo}/releases/download/v${version}"

sum() {
  local line
  line="$(curl -fsSL "$1")" || { echo "missing: $1" >&2; exit 1; }
  line="${line%% *}"
  [[ "$line" =~ ^[0-9a-f]{64}$ ]] || { echo "bad checksum from $1" >&2; exit 1; }
  printf '%s' "$line"
}

x86_64="$(sum "${release}/sweep-linux-x64.sha256")"
aarch64="$(sum "${release}/sweep-linux-arm64.sha256")"
# The licence has no sidecar; hash the file at the release tag.
license_sum="$(curl -fsSL "https://raw.githubusercontent.com/${repo}/v${version}/LICENSE" | sha256sum | cut -c1-64)"

sed -i \
  -e "s/^pkgver=.*/pkgver=${version}/" \
  -e "s/^pkgrel=.*/pkgrel=1/" \
  -e "s/^sha256sums=.*/sha256sums=('${license_sum}')/" \
  -e "s/^sha256sums_x86_64=.*/sha256sums_x86_64=('${x86_64}')/" \
  -e "s/^sha256sums_aarch64=.*/sha256sums_aarch64=('${aarch64}')/" \
  "${here}/PKGBUILD"

# .SRCINFO from the PKGBUILD's own values, in the order makepkg prints them.
(
  # shellcheck source=/dev/null
  source "${here}/PKGBUILD"
  field() { local key=$1; shift; for value in "$@"; do printf '\t%s = %s\n' "$key" "$value"; done; }
  printf 'pkgbase = %s\n' "$pkgname"
  field pkgdesc "$pkgdesc"
  field pkgver "$pkgver"
  field pkgrel "$pkgrel"
  field url "$url"
  field arch "${arch[@]}"
  field license "${license[@]}"
  field provides "${provides[@]}"
  field conflicts "${conflicts[@]}"
  field options "${options[@]}"
  field source "${source[@]}"
  field sha256sums "${sha256sums[@]}"
  field source_x86_64 "${source_x86_64[@]}"
  field sha256sums_x86_64 "${sha256sums_x86_64[@]}"
  field source_aarch64 "${source_aarch64[@]}"
  field sha256sums_aarch64 "${sha256sums_aarch64[@]}"
  printf '\npkgname = %s\n' "$pkgname"
) > "${here}/.SRCINFO"

echo "rendered sweep-cli-bin ${version}"
