#!/bin/sh
REAL_GH="/usr/bin/gh"

# Pull requests must go through the create-pull-request tool so the bridge can
# track them, so reject `gh pr create` (and its `gh pr new` alias), with any
# other flags interspersed anywhere in the invocation, without disturbing
# "$@" for the exec below.
# -R/--repo takes a separate value token (and can precede "pr"), so its value
# is skipped rather than counted as a positional argument.
pos1=""
pos2=""
skip_next=0
for arg in "$@"; do
  if [ "$skip_next" = 1 ]; then
    skip_next=0
    continue
  fi
  case "$arg" in
  -R | --repo)
    skip_next=1
    ;;
  -*) ;;
  *)
    if [ -z "$pos1" ]; then
      pos1="$arg"
    elif [ -z "$pos2" ]; then
      pos2="$arg"
    fi
    ;;
  esac
done
if [ "$pos1" = "pr" ] && { [ "$pos2" = "create" ] || [ "$pos2" = "new" ]; }; then
  echo "error: 'gh pr $pos2' is disabled; use the create-pull-request tool to open a pull request" >&2
  exit 1
fi

token=$(python3 -m sandbox_runtime.credentials.git_credential_helper gh-token || true)
if [ -n "$token" ]; then
  export GH_TOKEN="$token"
fi
exec "$REAL_GH" "$@"
