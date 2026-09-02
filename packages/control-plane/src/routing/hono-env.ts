/** Hono environment shared by the control-plane app, its middleware, and its hosts. */

import type { Hono } from "hono";
import type { RequestContext } from "../http/request-context";
import type { BackgroundTasks } from "../platform-ports";
import type { Route } from "../routes/shared";
import type { Env } from "../types";
import type { AdmissionPolicy, RouteAdmission } from "./admit";

export type ControlPlaneHonoEnv = {
  Bindings: Env;
  Variables: {
    requestContext: RequestContext;
    startedAt: number;
    /** Set by `admit()` before it evaluates the route, so an admission failure still gets the route's response policy. */
    routePolicy?: AdmissionPolicy;
    /** Set by `admit()` once the route's policy has been evaluated. */
    admission?: RouteAdmission;
    /** Set by the app-owned responders that answer without a route policy. */
    admissionExempt?: true;
  };
};

/** The execution context a platform passes to `app.fetch`, when it passes one. */
export interface PlatformExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** What the platform running the app supplies per request. */
export interface ControlPlaneHost {
  /** Background-task port for one request. Cloudflare extends the event through `waitUntil`; a host without one supplies its own. */
  backgroundTasks(executionCtx: PlatformExecutionContext | undefined): BackgroundTasks;
}

/** A route module: a Hono sub-app whose every route is registered behind `admit()`. */
export type RouteModule = Hono<ControlPlaneHonoEnv>;

/** What the catalog lists, in precedence order: converted modules and, until they convert, legacy routes. */
export type RouteCatalogEntry = Route | RouteModule;
