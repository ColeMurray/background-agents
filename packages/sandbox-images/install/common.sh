#!/usr/bin/env bash
set -euo pipefail
download_checked() {
  local url="$1" digest="$2" destination="$3"
  curl --fail --show-error --location --retry 3 --output "$destination" "$url"
  printf '%s  %s\n' "$digest" "$destination" | sha256sum --check -
}
