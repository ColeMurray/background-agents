#!/usr/bin/env bash
# Open-Inspect runtime launcher for Boat sandboxes.
#
# Baked into the base snapshot at /home/user/openinspect/launcher.sh. A new
# session sandbox starts it from its create-time setup script once the machine
# is up; the control plane starts it, detached, after every resume and for an
# image build. A resume usually lands on a fresh machine, where nothing from
# the previous boot survives, but one soon after the stop can get the parked
# machine back with its runtime still running, which step 3 detects. It
# runs as `user` with the session env Boat applies from the sandbox's
# create-time env; nothing rides its command line. An image build's env arrives
# as a file instead (see step 5).
#
# In order, it
#   1. recreates what a Boat snapshot does not carry: the /workspace and /app
#      links into the home directory (the image keeps their content under
#      /home/user so it is saved), /tmp/opencode and the SCM credential cache;
#   2. waits for the restored toolchain under /opt/openinspect, which a resumed
#      machine copies in shortly after it reports ready;
#   3. takes the single-instance lock, exiting EXIT_ALREADY_RUNNING when a
#      runtime already holds it. The lock file lives in /tmp, which belongs to
#      the machine for its whole life. The first boot takes the lock while
#      Boat's lazy restore still serves the home directory from the snapshot;
#      once the disk has hydrated, the same path under /home names a different
#      file, which a second launcher would lock just as easily, starting a
#      second runtime beside the first;
#   4. points the runtime's cross-boot state (OPENINSPECT_STATE_DIR: the
#      harness session id, the repository manifest with the session-start
#      commits) at the home directory, because a Boat snapshot keeps /home but
#      never /tmp, where that state lives on other providers. An image build
#      (IMAGE_BUILD_MODE=true, stated by the control plane on every boot) is
#      the exception: its log and state stay under /tmp too, so the disk the
#      build leaves behind, which is saved as the prebuilt image, carries the
#      workspace and nothing of the build that produced it;
#   5. in image-build mode, loads the build's env — the repository set, the
#      clone token, the scope's secrets, the callback contract — from the file
#      the control plane wrote once the sandbox was private, and removes it.
#      Nothing of the build rides the create-time env, which a saved snapshot
#      saved from the sandbox would inherit;
#   6. decides the boot mode from the completed-boot marker: the runtime
#      creates it (OI_BOOT_COMPLETE_MARKER) once a boot has synced the
#      checkout, run setup.sh and started the harness. A later boot that finds
#      it exports RESTORED_FROM_SNAPSHOT=true, so the runtime keeps its
#      checkout and skips setup.sh exactly as for a restored snapshot on any
#      other provider; a boot that was interrupted before then leaves no
#      marker and the next start boots fresh again;
#   7. execs the runtime entrypoint with its output in the supervisor log.
#
# `--prepare-only` performs steps 1 and 2 and exits; the image build uses it to
# verify a fresh deploy without starting a session runtime. The one value that
# ever rides the command line is an image build's own sandbox id, as a
# variable prefix the control plane adds for the build callback.
set -euo pipefail

OI_USER_HOME=/home/user
OI_INSTALL_HOME=$OI_USER_HOME/openinspect
if [[ "${IMAGE_BUILD_MODE:-}" == "true" ]]; then
  OI_STATE_DIR=/tmp/openinspect-image-build
else
  OI_STATE_DIR=$OI_USER_HOME/.openinspect
fi
# The machine's own /tmp, never the state directory under /home (step 3).
OI_LOCK_FILE=/tmp/openinspect-runtime.lock
OI_BOOT_COMPLETE_MARKER=$OI_STATE_DIR/boot-complete
OI_RUNTIME_STATE_DIR=$OI_STATE_DIR/state
OI_SUPERVISOR_LOG=$OI_STATE_DIR/supervisor.log
# Mirrors BOAT_IMAGE_BUILD_ENV_FILE_PATH in the control plane (boat-build-resources.ts).
OI_BUILD_ENV_FILE=/tmp/openinspect-image-build.env
OI_PYTHON=/opt/openinspect/python/bin/python
OI_RUNTIME_ENVIRONMENT=/app/openinspect-runtime-environment.json
OI_TOOLCHAIN_WAIT_SECONDS=${OI_TOOLCHAIN_WAIT_SECONDS:-120}
EXIT_ALREADY_RUNNING=75

log() { printf 'openinspect-launcher: %s\n' "$*" >&2; }

# ensure_link <link> <target>: make <link> a symlink to <target>, replacing an
# empty directory (the base image ships an empty /app). Anything else at
# <link> is somebody's data and is left alone.
ensure_link() {
  local link="$1" target="$2"
  mkdir -p "$target"
  if [[ -L "$link" && "$(readlink "$link")" == "$target" ]]; then
    return
  fi
  if [[ -e "$link" && ! -L "$link" ]]; then
    if [[ -d "$link" && -z "$(ls -A "$link")" ]]; then
      sudo rmdir "$link"
    else
      log "refusing to replace non-empty $link"
      exit 1
    fi
  fi
  sudo ln -sfn "$target" "$link"
}

prepare() {
  mkdir -p "$OI_STATE_DIR" "$OI_RUNTIME_STATE_DIR" "$OI_USER_HOME/workspace" \
    "$OI_INSTALL_HOME/app" "$OI_USER_HOME/.cache/openinspect/scm" /tmp/opencode
  ensure_link /workspace "$OI_USER_HOME/workspace"
  ensure_link /app "$OI_INSTALL_HOME/app"
  local waited=0
  until [[ -x "$OI_PYTHON" && -f "$OI_RUNTIME_ENVIRONMENT" ]]; do
    if (( waited >= OI_TOOLCHAIN_WAIT_SECONDS )); then
      log "runtime toolchain missing after ${OI_TOOLCHAIN_WAIT_SECONDS}s ($OI_PYTHON, $OI_RUNTIME_ENVIRONMENT)"
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# load_build_env: source an image build's env from the file the control plane
# wrote after the sandbox became private, then remove it. A build without its
# env cannot clone or call back, so a missing file ends the launch here, where
# the control plane's settle window sees the exit.
load_build_env() {
  if [[ ! -f "$OI_BUILD_ENV_FILE" ]]; then
    log "image build env file missing: $OI_BUILD_ENV_FILE"
    exit 1
  fi
  # shellcheck disable=SC1090
  . "$OI_BUILD_ENV_FILE"
  rm -f "$OI_BUILD_ENV_FILE"
}

main() {
  if [[ "${1:-}" == "--prepare-only" ]]; then
    prepare
    log "prepared"
    exit 0
  fi
  if (( $# )); then
    log "unknown argument: $1"
    exit 2
  fi
  prepare
  exec 9>"$OI_LOCK_FILE"
  if ! flock -n 9; then
    log "runtime already running"
    exit "$EXIT_ALREADY_RUNNING"
  fi
  if [[ "${IMAGE_BUILD_MODE:-}" == "true" ]]; then
    load_build_env
  fi
  export OI_BOOT_COMPLETE_MARKER
  export OPENINSPECT_STATE_DIR="$OI_RUNTIME_STATE_DIR"
  if [[ -e "$OI_BOOT_COMPLETE_MARKER" ]]; then
    export RESTORED_FROM_SNAPSHOT=true
    log "an earlier boot completed; starting the runtime in restored mode"
  else
    log "no completed boot on this disk; starting the runtime fresh"
  fi
  if [[ -f "$OI_SUPERVISOR_LOG" ]]; then
    mv -f "$OI_SUPERVISOR_LOG" "$OI_SUPERVISOR_LOG.1"
  fi
  cd /workspace
  exec "$OI_PYTHON" -m sandbox_runtime.entrypoint >>"$OI_SUPERVISOR_LOG" 2>&1
}

main "$@"
