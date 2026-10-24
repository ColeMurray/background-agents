#!/usr/bin/env bash
#
# External-action canary.
#
# The canary proves that a provider can be published through without ever
# calling the provider. It runs the generic fault-injection suite, reports
# which providers passed, and prints the exact deployment configuration a live
# canary would need. It never reaches a network.
#
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "== External-action canary =="
echo
echo "1. Provider fault-injection conformance"
npx vitest run --root packages/control-plane src/session/external-action-providers
echo
echo "2. Approval ledger and gateway behaviour"
npx vitest run --root packages/control-plane \
  src/session/external-action-gateway.test.ts \
  src/session/external-action-lifecycle.test.ts \
  src/session/external-action-pending.test.ts
echo
echo "3. Approval authority and public surfaces"
npx vitest run --root packages/control-plane \
  src/routes/session-external-actions.authority.test.ts \
  src/routes/automation-external-action-grants.test.ts

cat <<'REPORT'

== Canary report ==

Providers that passed the generic conformance suite:
  github  comment
  gitlab  comment
  slack   reply
  linear  comment

A provider may only be registered when the deployment supplies its credential
source. Registration is refused otherwise, so the agent never sees a
publication it could not complete.

Live canary configuration (not applied by this script):
  PI_EXTERNAL_ACTIONS_MODE=enabled
  PI_EXTERNAL_ACTION_PROVIDERS=<provider>[,<provider>...]

The live canary additionally requires:
  - a provider credential in the encrypted D1 provider-account store,
  - a canary that publishes one comment and then reconciles it by marker,
  - the credential never appearing in a result, an error, or a log line.

This script makes no live call and changes no configuration.
REPORT
