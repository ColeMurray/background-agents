import type { Route } from "./shared";
import { sessionCreateRoutes } from "./session-create";
import { sessionAttachmentRoutes } from "./session-attachments";
import { sessionChildRoutes } from "./session-children";
import { sessionChildSpawnRoutes } from "./session-child-spawn";
import { sessionFileRoutes } from "./session-files";
import { sessionIndexRoutes } from "./session-index";
import { sessionMediaRoutes } from "./session-media";
import { sessionPromptRoutes } from "./session-prompt";
import { sessionRuntimeProxyRoutes } from "./session-runtime-proxy";
import { sessionWsTokenRoutes } from "./session-ws-token";

export const sessionRoutes: Route[] = [
  ...sessionCreateRoutes,
  ...sessionAttachmentRoutes,
  ...sessionFileRoutes,
  ...sessionIndexRoutes,
  ...sessionRuntimeProxyRoutes,
  ...sessionWsTokenRoutes,
  ...sessionPromptRoutes,
  ...sessionMediaRoutes,
  ...sessionChildSpawnRoutes,
  ...sessionChildRoutes,
];
