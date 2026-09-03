import { Hono } from "hono";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { sessionMediaStreamRoutes } from "./session-media-stream";
import { sessionMediaUploadRoutes } from "./session-media-upload";

export const sessionMediaRoutes = new Hono<ControlPlaneHonoEnv>();
sessionMediaRoutes.route("/", sessionMediaUploadRoutes);
sessionMediaRoutes.route("/", sessionMediaStreamRoutes);
