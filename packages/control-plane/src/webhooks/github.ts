/**
 * GitHub automation event webhook route — internal endpoint that receives
 * pre-normalized GitHubAutomationEvents from the github-bot and proxies
 * them to the SchedulerDO for automation matching and session dispatch.
 */

import { createAutomationEventRoute } from "./automation-event";

export const githubAutomationEventRoute = createAutomationEventRoute({
  path: "/internal/github-event",
  source: "github",
  validate: (event) =>
    !event.repoOwner || !event.repoName
      ? "Invalid event: repoOwner and repoName are required"
      : null,
});
