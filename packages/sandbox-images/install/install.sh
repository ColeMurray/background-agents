#!/usr/bin/env bash
# Runs only while constructing a disposable image candidate, never at session boot.
set -euo pipefail
OI_BUNDLE="$(cd "$(dirname "$0")/../../.." && pwd)"
OI_INSTALL_DIR="$OI_BUNDLE/packages/sandbox-images/install"
source "$OI_BUNDLE/image-config.sh"
export OI_BUNDLE OI_INSTALL_DIR
if [[ "$(id -u)" != 0 || "$(uname -m)" != x86_64 ]]; then
  echo 'Image installation requires root on linux/amd64' >&2
  exit 1
fi
trap 'echo "Image installation failed in phase ${OI_PHASE:-initialization}" >&2' ERR
phases=("os/$OI_OS" languages tools runtime filesystem)
if (( $# )); then phases=("$@"); fi
for OI_PHASE in "${phases[@]}"; do
  if [[ "$OI_PHASE" == os ]]; then OI_PHASE="os/$OI_OS"; fi
  echo "openinspect.image.phase=$OI_PHASE"
  bash "$OI_INSTALL_DIR/$OI_PHASE.sh"
done
if (( $# == 0 )); then
  /opt/openinspect/python/bin/python "$OI_BUNDLE/packages/sandbox-images/verify/smoke_test.py" install
fi
