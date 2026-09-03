import { Hono } from "hono";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
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

/** Mount order is precedence order: `/sessions/inbox` must register before `/sessions/:id`. */
export const sessionRoutes = new Hono<ControlPlaneHonoEnv>();
for (const module of [
  sessionCreateRoutes,
  sessionIndexRoutes,
  sessionRuntimeProxyRoutes,
  sessionWsTokenRoutes,
  sessionPromptRoutes,
  sessionPullRequestRoutes,
  sessionMediaRoutes,
  sessionAttachmentRoutes,
  sessionDiffRoutes,
  sessionSkillRoutes,
  sessionChildSpawnRoutes,
  sessionChildRoutes,
]) {
  sessionRoutes.route("/", module);
}
