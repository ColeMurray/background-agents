/**
 * Slack automation event webhook route — internal endpoint that receives
 * pre-normalized SlackAutomationEvents from the slack-bot and proxies them
 * to the SchedulerDO for automation matching and session dispatch.
 *
 * The slack-bot is responsible for ingress filtering (watched channels,
 * mention suppression) and normalization; this endpoint only authenticates,
 * validates the event envelope, and forwards. Channel-keyed candidate
 * selection, condition evaluation, and dedup all happen in the scheduler.
 */

import { createAutomationEventRoute } from "./automation-event";

export const slackAutomationEventRoute = createAutomationEventRoute({
  path: "/internal/slack-event",
  source: "slack",
  validate: (event) =>
    !event.channelId || !event.ts ? "Invalid event: channelId and ts are required" : null,
});
