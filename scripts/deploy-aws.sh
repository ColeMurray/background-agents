#!/bin/bash
# Deploy one already-pushed image to an AWS control-plane instance, and put the
# previous one back if it does not come up healthy.
#
#   AWS_REGION=... DEPLOYED_IMAGE_PARAMETER=... INSTANCE_ID=... \
#   HEALTHCHECK_URL=... IMAGE_REF=... scripts/deploy-aws.sh
#
# Before pushing any tags, pin a bootstrap deployment's rollback reference:
#   AWS_REGION=... DEPLOYED_IMAGE_PARAMETER=... AWS_ECR_REPOSITORY=... \
#     scripts/deploy-aws.sh --pin-current-image
#
# The deployed version is an SSM parameter the instance reads into `.env` on
# every activation, so a deploy is a parameter write plus one remote command --
# no new instance, and no ssh. The command fetches (which brings down the stack
# files, `.env` and the activation script itself) and, only if that worked, runs
# the activation, which pulls and `up -d --wait`s without stopping the old stack
# first: a failure before the swap leaves the running deployment untouched.
#
# It names those two steps rather than a helper baked into the instance, because
# the instance ignores `user_data_base64` -- a host keeps whatever cloud-init
# wrote at its first boot, so anything a deploy assumes is installed there is an
# assumption about how old the instance is. Naming them costs the `set -e` the
# helper has, which is why they go as one `&&` command and not as two.
#
# A rollback is therefore the same command with the old value, which is why this
# script and not the workflow owns the sequence: the value to restore has to be
# read before anything moves.
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${DEPLOYED_IMAGE_PARAMETER:?DEPLOYED_IMAGE_PARAMETER is required}"

# How long the remote command may take, and how long after it the service has
# to answer. The command itself pulls an image over the instance's own link.
COMMAND_TIMEOUT_SECONDS="${COMMAND_TIMEOUT_SECONDS:-600}"
COMMAND_DELIVERY_TIMEOUT_SECONDS="${COMMAND_DELIVERY_TIMEOUT_SECONDS:-60}"
# Extra time to observe a terminal response after delivery plus execution.
# Expiring this local budget does not prove that the remote command stopped.
COMMAND_GRACE_SECONDS="${COMMAND_GRACE_SECONDS:-60}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-300}"
# "Healthy" is sustained, not a single 200: a container that answers once and
# then exits is the failure this is here to catch.
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-5}"
HEALTH_CONSECUTIVE="${HEALTH_CONSECUTIVE:-6}"
# Only the tests move this; the deploy has no reason to poll faster.
COMMAND_POLL_SECONDS="${COMMAND_POLL_SECONDS:-5}"

# Bounds on one SSM read. The CLI would otherwise wait 60s to connect and 60s to
# read, three attempts over, which can carry a single poll minutes past the
# deadline the loop below checks -- the loop is the retry, so no one call has a
# reason to take that long. Reads disable CLI retries because this loop retries.
SSM_READ_TIMEOUT=(--cli-connect-timeout 5 --cli-read-timeout 10)

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

is_digest_ref() {
  [[ "$1" =~ ^.+@sha256:[a-f0-9]{64}$ ]]
}

# This runs BEFORE the build/push step. Resolving :latest afterwards would pin
# the new image, not the bootstrap image rollback needs to restore. The module
# preserves this parameter across instance replacements, so future boots also
# keep the same image if the subsequent build or deployment fails.
if [ "${1:-}" = --pin-current-image ] && [ "$#" -eq 1 ]; then
  previous="$(read_deployed_image)"
  if is_digest_ref "$previous"; then
    log "rollback image already pinned: $previous"
    exit 0
  fi

  : "${AWS_ECR_REPOSITORY:?AWS_ECR_REPOSITORY is required to resolve a tag}"
  if [ "${previous%:*}" != "$AWS_ECR_REPOSITORY" ]; then
    log "cannot resolve rollback image outside $AWS_ECR_REPOSITORY; pin $previous to its running digest first"
    exit 1
  fi
  digest="$(aws ecr describe-images \
    --repository-name "${AWS_ECR_REPOSITORY#*/}" \
    --image-ids "imageTag=${previous##*:}" \
    --region "$AWS_REGION" \
    --query 'imageDetails[0].imageDigest' --output text)"
  pinned="$AWS_ECR_REPOSITORY@$digest"
  if ! is_digest_ref "$pinned"; then
    log "could not resolve rollback image $previous to a digest"
    exit 1
  fi
  write_deployed_image "$pinned"
  log "pinned rollback image: $pinned"
  exit 0
elif [ "$#" -ne 0 ]; then
  log "usage: $0 [--pin-current-image]"
  exit 1
fi

: "${INSTANCE_ID:?INSTANCE_ID is required}"
: "${HEALTHCHECK_URL:?HEALTHCHECK_URL is required}"
: "${IMAGE_REF:?IMAGE_REF is required}"

# Fetches and activates on the instance, waiting for the result and printing
# whatever it wrote. Returns 1 for a confirmed failure, or 2 when execution is
# uncertain and starting another activation would risk overlapping this one.
activate() {
  local command_id status deadline execution_timeout parameters

  # `--timeout-seconds` bounds delivery only: once AWS-RunShellScript starts, it
  # runs to completion no matter what this script does. `executionTimeout` is
  # the document's own bound; we still need the agent's terminal response before
  # starting rollback. The document rejects anything under 30s; the
  # tests compress the local budget well below that, hence the floor.
  execution_timeout=$(( COMMAND_TIMEOUT_SECONDS < 30 ? 30 : COMMAND_TIMEOUT_SECONDS ))

  # One command rather than two, joined by `&&`. AWS-RunShellScript reports the
  # exit status of the last command it ran, so a fetch that fails ahead of an
  # activation that succeeds is reported as a success -- and that activation
  # would activate the `.env` already on the instance, which names the previous
  # image. `compose pull` and `up` would be no-ops, the health check would pass
  # because what is running is the deployment that was working a minute ago, and
  # this script would report having deployed an image the instance never
  # fetched. Nothing looks wrong, so nothing rolls back.
  #
  # This is what the instance's own `open-inspect-deploy` does under `set -e`.
  # Inlining the two steps here is deliberate -- a deploy must not assume how
  # old the instance is -- but it must not lose the `set -e` along with them.
  parameters="$(printf '{"commands":["%s"],"executionTimeout":["%s"]}' \
    "/usr/local/bin/open-inspect-fetch-config && exec bash /opt/open-inspect/deploy.sh" \
    "$execution_timeout")"

  # SendCommand has no idempotency token. A lost response must not cause a CLI
  # retry to submit a second activation, or a rollback to race the first one.
  command_id="$(AWS_MAX_ATTEMPTS=1 aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --comment "open-inspect deploy" \
    --parameters "$parameters" \
    --timeout-seconds "$COMMAND_DELIVERY_TIMEOUT_SECONDS" \
    --region "$AWS_REGION" \
    --query 'Command.CommandId' --output text)" || {
      log "could not confirm whether SSM accepted the activation"
      return 2
    }
  log "command $command_id sent"

  # Execution starts on delivery, not on SendCommand. Wait through both budgets
  # and require a terminal response; elapsed time alone is not an execution fence.
  deadline=$(( SECONDS + COMMAND_DELIVERY_TIMEOUT_SECONDS + execution_timeout + COMMAND_GRACE_SECONDS ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    sleep "$COMMAND_POLL_SECONDS"
    # A just-sent command is briefly unknown to GetCommandInvocation.
    status="$(AWS_MAX_ATTEMPTS=1 aws ssm get-command-invocation \
      --command-id "$command_id" --instance-id "$INSTANCE_ID" \
      --region "$AWS_REGION" "${SSM_READ_TIMEOUT[@]}" \
      --query 'StatusDetails' --output text 2>/dev/null)" || continue
    case "$status" in
      Pending | InProgress | "In Progress" | Delayed | Cancelling) continue ;;
      Success)
        log "command $command_id succeeded"
        return 0
        ;;
      Failed | "Execution Timed Out" | Cancelled | Undeliverable | "Invalid Platform" | "Access Denied")
        log "command $command_id ended $status"
        print_command_output "$command_id"
        return 1
        ;;
      *)
        # In particular, Delivery Timed Out can mean SSM never received the
        # agent's terminal response, not that an executing process was stopped.
        log "command $command_id has uncertain execution status: $status"
        print_command_output "$command_id"
        return 2
        ;;
    esac
  done

  log "command $command_id has no terminal status after delivery, execution and grace budgets"
  print_command_output "$command_id"
  return 2
}

print_command_output() {
  # Best effort: this runs on a path that is already failing, and an error here
  # would replace the reason the deploy failed with the reason the log fetch did.
  AWS_MAX_ATTEMPTS=1 aws ssm get-command-invocation \
    --command-id "$1" --instance-id "$INSTANCE_ID" --region "$AWS_REGION" \
    "${SSM_READ_TIMEOUT[@]}" \
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
if ! is_digest_ref "$previous" || ! is_digest_ref "$IMAGE_REF"; then
  log "deployment and rollback images must be digest-pinned; run --pin-current-image before pushing tags"
  exit 1
fi
log "currently deployed: $previous"
log "deploying:          $IMAGE_REF"

if [ "$previous" = "$IMAGE_REF" ]; then
  log "already deployed; activating anyway so the stack picks up any other change"
fi

write_deployed_image "$IMAGE_REF"

activation_status=0
activate || activation_status=$?
if [ "$activation_status" -eq 2 ]; then
  log "ACTIVATION OUTCOME UNKNOWN -- not rolling back while it may still be running"
  log "confirm the remote command has stopped before recovering; previous image: $previous"
  exit 1
fi

if [ "$activation_status" -eq 0 ] && healthy; then
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
