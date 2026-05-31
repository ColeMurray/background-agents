import type { Route } from "./shared";
import { sessionCreateRoutes } from "./session-create";
import { sessionChildRoutes } from "./session-children";
import { sessionChildSpawnRoutes } from "./session-child-spawn";
import { sessionIndexRoutes } from "./session-index";
import { sessionMediaRoutes } from "./session-media";
import { sessionPromptRoutes } from "./session-prompt";
import { sessionRuntimeProxyRoutes } from "./session-runtime-proxy";
import { sessionWsTokenRoutes } from "./session-ws-token";

export const sessionRoutes: Route[] = [
  ...sessionCreateRoutes,
  ...sessionIndexRoutes,
  ...sessionRuntimeProxyRoutes,
  ...sessionWsTokenRoutes,
  ...sessionPromptRoutes,
  ...sessionMediaRoutes,
  ...sessionChildSpawnRoutes,
  ...sessionChildRoutes,
];
