import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { json, NO_AUTHORIZATION, type RequestContext } from "./shared";
import type { Env } from "../types";

async function handleHealth(
  _request: Request,
  _env: Env,
  _params: object,
  _ctx: RequestContext
): Promise<Response> {
  return json({ status: "healthy", service: "open-inspect-control-plane" });
}

export const healthRoutes = new Hono<ControlPlaneHonoEnv>();

healthRoutes.get(
  "/health",
  admit({
    authentication: { kind: "public" },
    supportedScmProviders: "all",
    authorization: NO_AUTHORIZATION,
  }),
  (c) => dispatch(c, handleHealth)
);
