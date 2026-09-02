/** Hono environment shared by the control-plane app, its middleware, and its hosts. */

import type { RequestContext } from "../http/request-context";
import type { BackgroundTasks } from "../platform-ports";
import type { Env } from "../types";
import type { RouteAdmission } from "./admit";

export type ControlPlaneHonoEnv = {
  Bindings: Env;
  Variables: {
    requestContext: RequestContext;
    startedAt: number;
    /** Set by `admit()` once the route's policy has been evaluated. */
    admission?: RouteAdmission;
    /** Set by the app-owned responders that answer without a route policy. */
    admissionExempt?: true;
  };
};

/** What the platform running the app supplies per request. */
export interface ControlPlaneHost {
  /** Background-task port for one request, built from whatever the platform passed as the execution context. */
  backgroundTasks(executionCtx: unknown): BackgroundTasks;
}
