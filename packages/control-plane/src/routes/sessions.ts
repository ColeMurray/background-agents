import type { Route } from "./shared";
import { sessionCreateRoutes } from "./session-create";
import { sessionChildRoutes } from "./session-children";
import { sessionChildSpawnRoutes } from "./session-child-spawn";
import { sessionIndexRoutes } from "./session-index";
import { sessionMediaRoutes } from "./session-media";
import { sessionPromptRoutes } from "./session-prompt";
import { sessionPullRequestRoutes } from "./session-pull-requests";
import { sessionRuntimeProxyRoutes } from "./session-runtime-proxy";
import { sessionAttachmentRoutes } from "./session-attachments";
import { sessionWsTokenRoutes } from "./session-ws-token";
import { sessionDiffRoutes } from "./session-diffs";

export const sessionRoutes: Route[] = [
  ...sessionCreateRoutes,
  ...sessionIndexRoutes,
  ...sessionRuntimeProxyRoutes,
  ...sessionWsTokenRoutes,
  ...sessionPromptRoutes,
  ...sessionPullRequestRoutes,
  ...sessionMediaRoutes,
  ...sessionAttachmentRoutes,
  ...sessionDiffRoutes,
  ...sessionChildSpawnRoutes,
  ...sessionChildRoutes,
];
