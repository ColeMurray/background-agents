#!/usr/bin/env bash
set -euo pipefail
case "$OI_ARCH" in
  amd64) OI_NODE_ARCH=x64; OI_MACHINE_ARCH=x86_64; OI_CHROME_PLATFORM=linux64 ;;
  arm64) OI_NODE_ARCH=arm64; OI_MACHINE_ARCH=aarch64; OI_CHROME_PLATFORM=linux-arm64 ;;
  *) echo "Unsupported image architecture: $OI_ARCH" >&2; exit 1 ;;
esac
download_checked() {
  local url="$1" digest="$2" destination="$3"
  curl --fail --show-error --location --retry 3 --output "$destination" "$url"
  printf '%s  %s\n' "$digest" "$destination" | sha256sum --check -
}
