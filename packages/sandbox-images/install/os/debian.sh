#!/usr/bin/env bash
set -euo pipefail
source /etc/os-release
case "$ID" in debian|ubuntu) ;; *) echo "Unsupported Debian target: $ID" >&2; exit 1 ;; esac
export DEBIAN_FRONTEND=noninteractive
audio_library=libasound2
if [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]]; then audio_library=libasound2t64; fi
apt-get update
apt-get install -y --no-install-recommends git curl build-essential ca-certificates gnupg openssh-client jq unzip \
  passwd adduser sysvinit-utils procps util-linux xz-utils ffmpeg xvfb fluxbox x11vnc \
  websockify novnc libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 "$audio_library" \
  libpango-1.0-0 libcairo2
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y --no-install-recommends gh
