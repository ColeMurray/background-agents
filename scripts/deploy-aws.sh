#!/bin/bash
# Deploy one already-pushed image to an AWS control-plane instance, and put the
# previous one back if it does not come up healthy.
#
#   AWS_REGION=... DEPLOYED_IMAGE_PARAMETER=... INSTANCE_ID=... \
#   HEALTHCHECK_URL=... IMAGE_REF=... scripts/deploy-aws.sh
#
# The deployed version is an SSM parameter the instance reads into `.env` on
# every activation, so a deploy is a parameter write plus one remote command --
# no new instance, and no ssh. The command runs `open-inspect-deploy`, which
# fetches, pulls and `up -d --wait`s without stopping the old stack first, so a
# failure before the swap leaves the running deployment untouched.
#
# A rollback is therefore the same two steps with the old value, which is why
# this script and not the workflow owns the sequence: the value to restore has
# to be read before anything moves.
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${DEPLOYED_IMAGE_PARAMETER:?DEPLOYED_IMAGE_PARAMETER is required}"
: "${INSTANCE_ID:?INSTANCE_ID is required}"
: "${HEALTHCHECK_URL:?HEALTHCHECK_URL is required}"
: "${IMAGE_REF:?IMAGE_REF is required}"

# How long the remote command may take, and how long after it the service has
# to answer. The command itself pulls an image over the instance's own link.
COMMAND_TIMEOUT_SECONDS="${COMMAND_TIMEOUT_SECONDS:-600}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-300}"
# "Healthy" is sustained, not a single 200: a container that answers once and
# then exits is the failure this is here to catch.
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-5}"
HEALTH_CONSECUTIVE="${HEALTH_CONSECUTIVE:-6}"
# Only the tests move this; the deploy has no reason to poll faster.
COMMAND_POLL_SECONDS="${COMMAND_POLL_SECONDS:-5}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

read_deployed_image() {
  aws ssm get-parameter \
    --name "$DEPLOYED_IMAGE_PARAMETER" \
    --region "$AWS_REGION" \
    --query 'Parameter.Value' --output text
}

write_deployed_image() {
  aws ssm put-parameter \
    --name "$DEPLOYED_IMAGE_PARAMETER" \
    --type String --overwrite \
    --value "$1" \
    --region "$AWS_REGION" >/dev/null
}

# Runs open-inspect-deploy on the instance and waits for it, printing whatever
# it wrote. Returns non-zero on any failure, including a command that never
# reaches a terminal state inside the budget.
activate() {
  local command_id status deadline
  command_id="$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --comment "open-inspect deploy" \
    --parameters '{"commands":["/usr/local/bin/open-inspect-deploy"]}' \
    --timeout-seconds "$COMMAND_TIMEOUT_SECONDS" \
    --region "$AWS_REGION" \
    --query 'Command.CommandId' --output text)" || return 1
  log "command $command_id sent"

  deadline=$(( SECONDS + COMMAND_TIMEOUT_SECONDS ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    sleep "$COMMAND_POLL_SECONDS"
    # A just-sent command is briefly unknown to GetCommandInvocation.
    status="$(aws ssm get-command-invocation \
      --command-id "$command_id" --instance-id "$INSTANCE_ID" \
      --region "$AWS_REGION" --query 'Status' --output text 2>/dev/null)" || continue
    case "$status" in
      Pending | InProgress | Delayed) continue ;;
      Success)
        log "command $command_id succeeded"
        return 0
        ;;
      *)
        log "command $command_id ended $status"
        print_command_output "$command_id"
        return 1
        ;;
    esac
  done

  log "command $command_id did not finish within ${COMMAND_TIMEOUT_SECONDS}s"
  print_command_output "$command_id"
  return 1
}

print_command_output() {
  # Best effort: this runs on a path that is already failing, and an error here
  # would replace the reason the deploy failed with the reason the log fetch did.
  aws ssm get-command-invocation \
    --command-id "$1" --instance-id "$INSTANCE_ID" --region "$AWS_REGION" \
    --query '[StandardOutputContent,StandardErrorContent]' --output text 2>/dev/null ||
    log "could not read the command's output"
}

healthy() {
  local deadline streak=0
  deadline=$(( SECONDS + HEALTH_TIMEOUT_SECONDS ))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 10 -o /dev/null "$HEALTHCHECK_URL"; then
      streak=$(( streak + 1 ))
      if [ "$streak" -ge "$HEALTH_CONSECUTIVE" ]; then
        log "healthy: $HEALTH_CONSECUTIVE consecutive checks"
        return 0
      fi
    elif [ "$streak" -ne 0 ]; then
      log "health check flapped after $streak good checks; starting over"
      streak=0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done

  log "not healthy within ${HEALTH_TIMEOUT_SECONDS}s"
  return 1
}

previous="$(read_deployed_image)"
log "currently deployed: $previous"
log "deploying:          $IMAGE_REF"

if [ "$previous" = "$IMAGE_REF" ]; then
  log "already deployed; activating anyway so the stack picks up any other change"
fi

write_deployed_image "$IMAGE_REF"

if activate && healthy; then
  log "deployed $IMAGE_REF"
  exit 0
fi

log "rolling back to $previous"
write_deployed_image "$previous"

if activate && healthy; then
  log "rolled back to $previous; the deployment is serving the previous image"
else
  log "ROLLBACK DID NOT COME BACK HEALTHY -- this needs a human"
fi

exit 1
