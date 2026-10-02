import { Hono } from "hono";
import { TeamSettingsStore, teamSettingsSchema } from "../db/team-settings";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  error,
  json,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type RequestContext,
} from "./shared";

async function getSettings(_request: Request, _env: Env, _params: object, ctx: RequestContext) {
  return json(await new TeamSettingsStore(ctx.db).get());
}

async function patchSettings(request: Request, _env: Env, _params: object, ctx: RequestContext) {
  const body = await parseBody(
    request,
    teamSettingsSchema.partial().strict(),
    "Invalid team settings"
  );
  if (body instanceof Response) return body;
  if (body.requireTeamOnCreate === undefined) return error("requireTeamOnCreate is required", 400);
  const store = new TeamSettingsStore(ctx.db);
  await store.set({ requireTeamOnCreate: body.requireTeamOnCreate });
  return json(await store.get());
}

export const teamSettingsRoutes = new Hono<ControlPlaneHonoEnv>();
const manage = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: requirePermission("workspace.members.manage", { service: "deny" }),
});
teamSettingsRoutes.get("/settings/teams", manage, (c) => dispatch(c, getSettings));
teamSettingsRoutes.patch("/settings/teams", manage, (c) => dispatch(c, patchSettings));
