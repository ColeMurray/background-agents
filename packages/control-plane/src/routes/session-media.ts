import type { Route } from "./shared";
import { sessionMediaStreamRoutes } from "./session-media-stream";
import { sessionMediaUploadRoutes } from "./session-media-upload";

export const sessionMediaRoutes: Route[] = [
  ...sessionMediaUploadRoutes,
  ...sessionMediaStreamRoutes,
];
