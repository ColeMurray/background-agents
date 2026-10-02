/**
 * Slack integration settings read by the slack-bot and the automation form.
 */

import { listChannels, type ControlPlaneSlackChannelsResponse } from "@open-inspect/shared/slack";
import { SlackChannelStore } from "../db/slack-channel-store";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  type RequestContext,
  GITHUB_USER_OR_SERVICE_ROUTE,
  json,
  requirePermission,
} from "./shared";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { AUTOMATIONS_READ } from "./automation-shared";

const logger = createLogger("router:automations");

/**
 * GET /integration-settings/slack/watched-channels
 *
 * Returns the distinct set of Slack channel IDs referenced by enabled
 * `slack_event` automations. The slack-bot polls this (cached) to pre-filter
 * channel messages before normalizing and forwarding them — only messages in a
 * watched channel are worth forwarding to the scheduler.
 *
 * Grouped under the `/integration-settings/slack` prefix the bot already uses
 * for its runtime config (routing rules), even though the data is sourced from
 * the automations store. Internal-auth gated by the router (non-public route).
 */
async function handleGetWatchedSlackChannels(
  _request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const channels = await new SlackChannelStore(ctx.db).getWatchedSlackChannels();
  return json({ channels });
}

/**
 * GET /integration-settings/slack/channels
 *
 * Lists the workspace's channels (public + private the bot can see) so the
 * automation and team binding forms can offer a channel picker. Sourced
 * live from Slack via `conversations.list` using the bot token.
 *
 * Returns `{ channels }` on success, or `{ channels: [], error }` when the token
 * is unset or Slack rejects the call (e.g. missing `channels:read`/`groups:read`
 * scope) — the form then degrades to manual channel-ID entry. Internal-auth gated
 * by the router (non-public route).
 */
export async function handleGetSlackChannels(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  if (!env.SLACK_BOT_TOKEN) {
    return json({
      channels: [],
      error: "not_configured",
    } satisfies ControlPlaneSlackChannelsResponse);
  }
  const result = await listChannels(env.SLACK_BOT_TOKEN, { signal: request.signal });
  if (!result.ok) {
    logger.warn("slack.channels.list_failed", { slack_error: result.error });
    return json({ channels: [], error: result.error } satisfies ControlPlaneSlackChannelsResponse);
  }
  let channels = result.channels;
  if (ctx.teamAdmission && !ctx.authorization?.permissions.includes("automations.read")) {
    // A team capability must not expose unrelated private workspace channels.
    const bindings = await new TeamChannelBindingStore(ctx.db).listByTeam(
      ctx.teamAdmission.team.id
    );
    const boundIds = new Set(
      bindings
        .filter((binding) => binding.provider === "slack")
        .map((binding) => binding.externalId)
    );
    channels = channels.filter((channel) => !channel.isPrivate || boundIds.has(channel.id));
  }
  return json({ channels } satisfies ControlPlaneSlackChannelsResponse);
}

export const automationSlackSettingsRoutes = new Hono<ControlPlaneHonoEnv>();

automationSlackSettingsRoutes.get(
  "/integration-settings/slack/watched-channels",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("automations.read", {
      actorlessGrants: [{ service: "slack-bot" }],
    }),
  }),
  (c) => dispatch(c, handleGetWatchedSlackChannels)
);
automationSlackSettingsRoutes.get("/integration-settings/slack/channels", AUTOMATIONS_READ, (c) =>
  dispatch(c, handleGetSlackChannels)
);
