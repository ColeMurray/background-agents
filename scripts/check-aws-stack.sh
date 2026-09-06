#!/usr/bin/env bash
#
# Static checks for the AWS deployment artifacts nothing else parses.
#
# `terraform validate` reads the module's HCL but never renders its user-data
# template, the compose smoke boots docker-compose.smoke.yml rather than the AWS
# overlay, and the deploy script only ever runs in a CI job against a live
# instance. A mistake in any of them would first be seen as a control plane that
# does not come up.
#
#   scripts/check-aws-stack.sh
#
# Requires Docker with Compose v2, and shellcheck (or Docker, as a fallback).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_ROOT/terraform/modules/aws-control-plane/templates/user-data.sh.tftpl"
RENDERED="$(mktemp -t user-data.XXXXXX).sh"
trap 'rm -f "$RENDERED"' EXIT

# Stand-ins for what templatefile() substitutes. The renderer fails on a
# variable it has no stub for, so a new one cannot slip through unchecked.
python3 - "$TEMPLATE" "$RENDERED" <<'PY'
import re, sys

stubs = {
    "region": "us-west-2",
    "log_group": "/open-inspect/example",
    "config_bucket": "example-backups",
    "ssm_env_prefix": "/example/env",
    "data_volume_id_nodash": "vol0123456789abcdef",
    "compose_version": "2.31.0",
    "compose_sha256": "0" * 64,
}

source = open(sys.argv[1]).read()
# `$${...}` is an escaped literal for the shell, not a template variable.
reference = re.compile(r"(?<!\$)\$\{([A-Za-z0-9_]+)\}")
missing = sorted(set(reference.findall(source)) - set(stubs))
if missing:
    sys.exit(f"no stub for template variable(s): {', '.join(missing)}; add them to this script")

rendered = reference.sub(lambda m: stubs[m.group(1)], source).replace("$${", "${")
open(sys.argv[2], "w").write(rendered)
PY

# shellcheck if it is installed, otherwise the same thing in a container --
# the checks a CI runner and a laptop run should not differ.
lint_shell() {
  bash -n "$1"
  if command -v shellcheck >/dev/null 2>&1; then
    shellcheck "$1"
  else
    docker run --rm -v "$(dirname "$1")":/mnt koalaman/shellcheck:stable "/mnt/$(basename "$1")"
  fi
}

lint_shell "$RENDERED"
echo "user-data template: syntax and shellcheck clean"

# The deploy script is the other thing here that only ever runs somewhere it is
# hard to iterate on: a CI job, against a live instance.
lint_shell "$REPO_ROOT/scripts/deploy-aws.sh"
echo "deploy script: syntax and shellcheck clean"

# ---------------------------------------------------------------------------
# The AWS overlay resolves to the stack the instance is meant to run
# ---------------------------------------------------------------------------
# Compose merge semantics are subtle enough to be worth pinning: `!reset` on
# `build` is what makes `up` pull rather than build, an unenabled profile is the
# only way to leave a service out of a merged stack, and `!reset` on Caddy's
# profile is what starts it. Any of those silently regressing changes what the
# instance runs.

STACK_ENV="$(mktemp -t aws-overlay-env.XXXXXX)"
# The base file names `.env` as the app's env_file, and Compose refuses to
# resolve a merged config without it. A checkout that has one keeps it; one that
# does not gets an empty file for the length of this check and no longer.
DOTENV_CREATED=0
if [ ! -e "$REPO_ROOT/.env" ]; then
  : >"$REPO_ROOT/.env"
  DOTENV_CREATED=1
fi
cleanup() {
  rm -f "$RENDERED" "$STACK_ENV"
  [ "$DOTENV_CREATED" -eq 1 ] && rm -f "$REPO_ROOT/.env"
  return 0
}
trap cleanup EXIT

cat >"$STACK_ENV" <<'ENV'
CONTROL_PLANE_IMAGE=example.invalid/control-plane:test
OBJECT_STORE_BUCKET=example-media
LITESTREAM_BUCKET=example-backups
MINIO_ROOT_PASSWORD=unused-on-aws
CADDY_DOMAIN=example.invalid
ENV

compose() {
  docker compose --env-file "$STACK_ENV" \
    -f "$REPO_ROOT/docker-compose.yml" -f "$REPO_ROOT/docker-compose.aws.yml" "$@"
}

# Resolved once, into a variable, so a Compose failure fails this script. Piping
# it straight into `grep` inside an `if` would swallow that and report a pass on
# a config that never resolved.
resolved="$(compose config)"
started="$(compose config --services | sort | tr '\n' ' ')"

expected="app caddy litestream "
if [ "$started" != "$expected" ]; then
  echo "AWS overlay starts [$started]; expected [$expected]" >&2
  exit 1
fi

# `build` surviving the merge would have the instance, which has no checkout,
# try to build the image instead of pulling the tag CI pushed.
if printf '%s\n' "$resolved" | grep -qE '^[[:space:]]+build:'; then
  echo "AWS overlay leaves a build context on a service; the instance has no checkout" >&2
  exit 1
fi

# The image has to come from the variable the module sets, not a stale literal.
if ! printf '%s\n' "$resolved" | grep -q 'example.invalid/control-plane:test'; then
  echo "AWS overlay does not take the app image from CONTROL_PLANE_IMAGE" >&2
  exit 1
fi

echo "AWS overlay: app, caddy and litestream, no build context, image from CONTROL_PLANE_IMAGE"
