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
import { sessionSkillRoutes } from "./session-skills";
import { externalSessionsRoutes } from "./external-sessions";
import { externalDiscoveryRoutes } from "./external-discovery";
import { externalSessionResourceRoutes } from "./external-session-resources";

export const sessionRoutes: Route[] = [
  ...externalSessionsRoutes,
  ...externalDiscoveryRoutes,
  ...externalSessionResourceRoutes,
  ...sessionCreateRoutes,
  ...sessionIndexRoutes,
  ...sessionRuntimeProxyRoutes,
  ...sessionWsTokenRoutes,
  ...sessionPromptRoutes,
  ...sessionPullRequestRoutes,
  ...sessionMediaRoutes,
  ...sessionAttachmentRoutes,
  ...sessionDiffRoutes,
  ...sessionSkillRoutes,
  ...sessionChildSpawnRoutes,
  ...sessionChildRoutes,
];
