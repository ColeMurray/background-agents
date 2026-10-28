/**
 * Team-scoped control-plane reads shared by the repos, environments, and
 * integration-settings modules.
 */

import type { Env, LinearChannelScope } from "./types";
import { signedControlPlaneFetch } from "./internal-auth";

/** A non-OK control-plane response, carrying the status for structured logs. */
export class ControlPlaneRequestError extends Error {
  constructor(
    path: string,
    readonly status: number
  ) {
    super(`Control plane GET ${path} failed with ${status}`);
    this.name = "ControlPlaneRequestError";
  }
}

/**
 * GET a control-plane endpoint on behalf of one Linear team and return its JSON
 * body, throwing {@link ControlPlaneRequestError} on a non-OK response.
 */
export async function fetchControlPlaneJson(
  env: Env,
  path: string,
  scope: LinearChannelScope,
  traceId?: string
): Promise<unknown> {
  const url = new URL(`https://internal${path}`);
  url.searchParams.set("channel", `linear:${scope.linearTeamId}`);
  const response = await signedControlPlaneFetch(
    env,
    {
      method: "GET",
      url: url.toString(),
      traceId,
      actor: scope.actorUserId ? `linear:${scope.actorUserId}` : undefined,
    },
    { headers: { Accept: "application/json" } }
  );
  if (!response.ok) {
    throw new ControlPlaneRequestError(path, response.status);
  }
  return response.json();
}
