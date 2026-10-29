import { Hono } from "hono";
import {
  DEFAULT_LINEAR_UNBOUND_CHANNELS,
  DEFAULT_SLACK_UNBOUND_CHANNELS,
} from "@open-inspect/shared/types/integrations";
import {
  channelBindingResponseSchema,
  type TeamChannelBindingProvider,
} from "@open-inspect/shared/types/team-channel-bindings";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import type { RequestContext } from "../http/request-context";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { error, json, serviceAuthorized } from "./shared";

/** Route admission already matched the calling bot to `provider`. */
async function getBinding(
  provider: TeamChannelBindingProvider,
  externalId: string,
  ctx: RequestContext
) {
  try {
    const binding = await new TeamChannelBindingStore(ctx.db).get(provider, externalId);
    if (binding) {
      return json(
        channelBindingResponseSchema.parse({ teamId: binding.teamId, kind: binding.kind })
      );
    }
    // Unbound Slack DMs are personal conversations, not team routing destinations.
    if (provider === "slack" && /^D[A-Z0-9]+$/.test(externalId)) {
      return json(channelBindingResponseSchema.parse({ teamId: null }));
    }
    const settings = await new IntegrationSettingsStore(ctx.db).getGlobal(provider);
    const defaultPolicy =
      provider === "slack" ? DEFAULT_SLACK_UNBOUND_CHANNELS : DEFAULT_LINEAR_UNBOUND_CHANNELS;
    if ((settings?.defaults?.unboundChannels ?? defaultPolicy) === "reject") {
      return json({ error: "Channel is not bound", code: "channel_unbound" }, 404);
    }
    return json(channelBindingResponseSchema.parse({ teamId: null }));
  } catch {
    return error("Channel binding lookup unavailable", 503);
  }
}

export const channelBindingRoutes = new Hono<ControlPlaneHonoEnv>();
for (const provider of ["slack", "linear"] as const) {
  channelBindingRoutes.get(
    `/channel-bindings/${provider}/:externalId`,
    admit({
      authentication: { kind: "service" },
      supportedScmProviders: "all",
      cacheControl: "private, no-store",
      authorization: serviceAuthorized(`${provider}-bot`),
    }),
    (c) =>
      dispatch(c, async (_request, _env, params, ctx) =>
        getBinding(provider, params.externalId, ctx)
      )
  );
}
