/**
 * The slack-bot's outbound control-plane fetch: sig1-signed as "slack-bot"
 * with this worker's own SERVICE_AUTH_SECRET and sent through the
 * `CONTROL_PLANE` service binding. All signing mechanics live in
 * `@open-inspect/shared`; this module only binds the service name.
 */

import {
  signedControlPlaneFetch as sharedSignedControlPlaneFetch,
  type OutboundRequestToSign,
  type SignedFetchInit,
} from "@open-inspect/shared";
import type { Env } from "./types";

export function signedControlPlaneFetch(
  env: Env,
  request: OutboundRequestToSign,
  init?: SignedFetchInit
): Promise<Response> {
  return sharedSignedControlPlaneFetch("slack-bot", env, request, init);
}
