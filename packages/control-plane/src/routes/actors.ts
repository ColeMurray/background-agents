import { Hono } from "hono";
import { actorProfileClaimsSchema } from "@open-inspect/shared/types/actors";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { parseBody } from "./body";
import {
  activeGlobal,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type ServiceActorClaimsResult,
} from "./shared";

async function extractEnrollActorClaims(request: Request): Promise<ServiceActorClaimsResult> {
  const body = await parseBody(request, actorProfileClaimsSchema);
  if (body instanceof Response) return { kind: "rejected", response: body };
  return { kind: "claims", claims: body };
}

async function handleEnrollActor(request: Request): Promise<Response> {
  // A known actor's admission ignores a refused body, so answer for it here.
  const body = await parseBody(request, actorProfileClaimsSchema);
  if (body instanceof Response) return body;
  return new Response(null, { status: 204 });
}

export const actorRoutes = new Hono<ControlPlaneHonoEnv>();

/**
 * Enroll the signed actor with its attested profile; admission does the work.
 * A new actor is linked to an existing user by email only at enrollment, and a
 * known actor is never relinked, so a bot calls this before any other request
 * carrying the actor. Otherwise a claim-less read enrolls a second user (#2435).
 * A browser user already is a user, so for them the call changes nothing.
 */
actorRoutes.post(
  "/actors/me",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: activeGlobal(),
    serviceActorClaims: extractEnrollActorClaims,
  }),
  (c) => dispatch(c, handleEnrollActor)
);
