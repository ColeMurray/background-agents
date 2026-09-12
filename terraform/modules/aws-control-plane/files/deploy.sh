#!/bin/bash
# Activates whatever the last `open-inspect-fetch-config` fetched: pulls the
# image `.env` now names and recreates only the containers that changed, without
# taking the running stack down first.
#
# This is deliberately not in user data. `aws_instance.this` ignores
# `user_data_base64`, and cloud-init runs it once, so anything written there is
# frozen at the instance's first boot and no `terraform apply` can move it. This
# file rides to the instance with the compose files instead, on every fetch --
# which is what lets the activation sequence change without a new instance.
#
# Run it through `open-inspect-deploy`, which fetches first.
set -euo pipefail

cd /opt/open-inspect
compose() { docker compose -f docker-compose.yml -f docker-compose.aws.yml "$@"; }

compose pull

# Bounded. `--wait` on its own waits indefinitely for a health check that a
# broken image never passes, and the deploy that sent this cannot start its
# rollback until this returns -- so an unbounded wait here is how a bad deploy
# becomes a long outage instead of a short one.
compose up -d --wait --wait-timeout 180
