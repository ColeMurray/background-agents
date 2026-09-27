#!/usr/bin/env bash
set -euo pipefail

workspace=/home/user/openinspect/workspace
state=/home/user/.openinspect
log="$state/runtime.log"

mkdir -p "$workspace" "$state"
exec 9>"$state/runtime.lock"
flock -n 9 || exit 0
printf '%s\n' "$$" > "$state/runtime.pid"

sudo rm -rf /app
sudo ln -s /home/user/openinspect/app /app

hydrated=false
stable_reads=0
hydration_started_seconds=$SECONDS
hydration_timeout_seconds=600
hydration_deadline_seconds=$((SECONDS + hydration_timeout_seconds))
while (( SECONDS < hydration_deadline_seconds )); do
  if [[ -e /opt/openinspect/python/bin/python \
    && -e /usr/local/bin/opencode \
    && -e /usr/local/bin/code-server \
    && -e /usr/local/bin/ttyd \
    && -e /usr/local/bin/google-chrome \
    && -e /usr/bin/Xvfb \
    && -e /usr/bin/fluxbox \
    && -e /usr/bin/x11vnc \
    && -f /app/verify/smoke_test.py \
    && -f /app/openinspect-build-config.json \
    && -f /usr/share/novnc/vnc.html ]] \
    && sudo tar -cf /dev/null \
    /opt/openinspect \
    /home/user/openinspect/app \
    /usr/bin/Xvfb \
    /usr/bin/fluxbox \
    /usr/bin/x11vnc \
    /usr/share/novnc 2>/dev/null; then
    stable_reads=$((stable_reads + 1))
    if (( stable_reads >= 3 )); then
      hydrated=true
      break
    fi
  else
    stable_reads=0
  fi
  sleep 1
done
if [[ "$hydrated" != true ]]; then
  echo "Boat snapshot did not finish hydrating the Open-Inspect runtime after $((SECONDS - hydration_started_seconds)) seconds" >&2
  for path in \
    /opt/openinspect/python/bin/python \
    /usr/local/bin/opencode \
    /usr/local/bin/code-server \
    /usr/local/bin/ttyd \
    /usr/local/bin/google-chrome \
    /usr/bin/Xvfb \
    /usr/bin/fluxbox \
    /usr/bin/x11vnc \
    /app/verify/smoke_test.py \
    /app/openinspect-build-config.json \
    /usr/share/novnc/vnc.html; do
    [[ -e "$path" || -L "$path" ]] || echo "Missing after hydration: $path" >&2
  done
  sudo tar -cf /dev/null \
    /opt/openinspect \
    /home/user/openinspect/app \
    /usr/bin/Xvfb \
    /usr/bin/fluxbox \
    /usr/bin/x11vnc \
    /usr/share/novnc >&2 || true
  exit 1
fi

sudo chmod -R a+rX \
  /opt/openinspect \
  /home/user/openinspect/app \
  /usr/share/novnc
sudo chmod a+rx \
  /usr/local/bin/opencode \
  /usr/local/bin/code-server \
  /usr/local/bin/ttyd \
  /usr/local/bin/google-chrome \
  /usr/bin/Xvfb \
  /usr/bin/fluxbox \
  /usr/bin/x11vnc
sudo rm -rf /workspace
sudo ln -s "$workspace" /workspace

if [[ "${1:-}" == --prepare-only ]]; then
  rm -f "$state/runtime.pid"
  exit 0
fi

if [[ -f "$state/runtime-started" ]]; then
  export RESTORED_FROM_SNAPSHOT=true
  export FROM_REPO_IMAGE=false
else
  touch "$state/runtime-started"
fi

if [[ -f "$log" ]] && (( $(stat -c %s "$log") > 10485760 )); then
  mv -f "$log" "$log.1"
fi
exec >>"$log" 2>&1
exec /opt/openinspect/python/bin/python -m sandbox_runtime.entrypoint
