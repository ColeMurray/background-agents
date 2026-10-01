import { Hono } from "hono";
import { DEFAULT_SLACK_UNBOUND_CHANNELS } from "@open-inspect/shared/types/integrations";
import { channelBindingResponseSchema } from "@open-inspect/shared/types/team-channel-bindings";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import type { RequestContext } from "../http/request-context";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { error, json, serviceAuthorized } from "./shared";

async function getBinding(
  _request: Request,
  _env: Env,
  params: { provider: string; externalId: string },
  ctx: RequestContext
) {
  if (params.provider !== "slack") return error("Unsupported channel binding provider", 400);
  const binding = await new TeamChannelBindingStore(ctx.db).get("slack", params.externalId);
  if (binding) {
    return json(channelBindingResponseSchema.parse({ teamId: binding.teamId, kind: binding.kind }));
  }
  const settings = await new IntegrationSettingsStore(ctx.db).getGlobal("slack");
  if ((settings?.defaults?.unboundChannels ?? DEFAULT_SLACK_UNBOUND_CHANNELS) === "reject") {
    return json({ error: "Channel is not bound", code: "channel_unbound" }, 404);
  }
  return json(channelBindingResponseSchema.parse({ teamId: null }));
}

export const channelBindingRoutes = new Hono<ControlPlaneHonoEnv>();
channelBindingRoutes.get(
  "/channel-bindings/:provider/:externalId",
  admit({
    authentication: { kind: "service" },
    supportedScmProviders: "all",
    cacheControl: "private, no-store",
    authorization: serviceAuthorized("slack-bot"),
  }),
  (c) => dispatch(c, getBinding)
);
