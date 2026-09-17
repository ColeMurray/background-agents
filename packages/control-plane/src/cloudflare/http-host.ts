/** The Cloudflare Worker's ordinary HTTP entrypoint over the control-plane app. */

import { catalog } from "../routes/catalog";
import {
  createControlPlaneApp,
  type ControlPlaneHost,
  type RouteModule,
} from "../routing/hono-app";
import type { Env } from "../types";
import { createCloudflareBackgroundTasks } from "./background-tasks";

/** The Worker's ordinary HTTP entrypoint signature, shared with the integration adapters. */
export type ControlPlaneHttpHandler = (
  request: Request,
  env: Env,
  executionCtx: ExecutionContext
) => Promise<Response>;

/** The Cloudflare Worker host: background tasks ride the event's `waitUntil`. */
export const cloudflareHost: ControlPlaneHost = {
  backgroundTasks: (executionCtx) => {
    if (!executionCtx) throw new Error("The Cloudflare host requires an execution context");
    return createCloudflareBackgroundTasks(executionCtx);
  },
};

/** Build the Worker's ordinary HTTP entrypoint over route modules. */
export function createControlPlaneHttpHandler(
  modules: readonly RouteModule[]
): ControlPlaneHttpHandler {
  const app = createControlPlaneApp(modules, cloudflareHost);
  return (request, env, executionCtx) => Promise.resolve(app.fetch(request, env, executionCtx));
}

/** Production entrypoint over the canonical route catalog. */
export const handleControlPlaneHttp: ControlPlaneHttpHandler =
  createControlPlaneHttpHandler(catalog);
