import { Hono } from "hono";
import {
  DEFAULT_LINEAR_UNBOUND_CHANNELS,
  DEFAULT_SLACK_UNBOUND_CHANNELS,
} from "@open-inspect/shared/types/integrations";
import {
  channelBindingResponseSchema,
  teamChannelBindingProviderSchema,
} from "@open-inspect/shared/types/team-channel-bindings";
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
  const provider = teamChannelBindingProviderSchema.safeParse(params.provider);
  if (!provider.success) return error("Unsupported channel binding provider", 400);
  if (ctx.principal?.kind !== "service" || ctx.principal.service !== `${provider.data}-bot`) {
    return json({ error: "Forbidden", code: "service_capability_required" }, 403);
  }
  try {
    const binding = await new TeamChannelBindingStore(ctx.db).get(provider.data, params.externalId);
    if (binding) {
      return json(
        channelBindingResponseSchema.parse({ teamId: binding.teamId, kind: binding.kind })
      );
    }
    // Unbound Slack DMs are personal conversations, not team routing destinations.
    if (provider.data === "slack" && /^D[A-Z0-9]+$/.test(params.externalId)) {
      return json(channelBindingResponseSchema.parse({ teamId: null }));
    }
    const settings = await new IntegrationSettingsStore(ctx.db).getGlobal(provider.data);
    const defaultPolicy =
      provider.data === "slack" ? DEFAULT_SLACK_UNBOUND_CHANNELS : DEFAULT_LINEAR_UNBOUND_CHANNELS;
    if ((settings?.defaults?.unboundChannels ?? defaultPolicy) === "reject") {
      return json({ error: "Channel is not bound", code: "channel_unbound" }, 404);
    }
    return json(channelBindingResponseSchema.parse({ teamId: null }));
  } catch {
    return error("Channel binding lookup unavailable", 503);
  }
}

export const channelBindingRoutes = new Hono<ControlPlaneHonoEnv>();
channelBindingRoutes.get(
  "/channel-bindings/:provider/:externalId",
  admit({
    authentication: { kind: "service" },
    supportedScmProviders: "all",
    cacheControl: "private, no-store",
    authorization: { ...serviceAuthorized("slack-bot"), services: ["slack-bot", "linear-bot"] },
  }),
  (c) => dispatch(c, getBinding)
);
