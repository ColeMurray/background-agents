import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { json, NO_AUTHORIZATION } from "./shared";

export const healthRoutes = new Hono<ControlPlaneHonoEnv>();

healthRoutes.get(
  "/health",
  admit({
    authentication: { kind: "public" },
    supportedScmProviders: "all",
    authorization: NO_AUTHORIZATION,
  }),
  () => json({ status: "healthy", service: "open-inspect-control-plane" })
);
