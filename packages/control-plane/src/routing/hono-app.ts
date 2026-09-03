/** Hono application for ordinary control-plane HTTP requests. */

import { Hono } from "hono";
import type { RouterRoute } from "hono/types";
import { TrieRouter } from "hono/router/trie-router";
import {
  auditRouteAuthorizationDecision,
  shouldAuditAllowedDecision,
} from "../authorization/request-audit";
import { createCloudflareBackgroundTasks } from "../cloudflare/background-tasks";
import { createRequestContext } from "../http/create-request-context";
import type { RequestContext } from "../http/request-context";
import { error, HttpError } from "../http/responses";
import { createLogger } from "../logger";
import { catalog } from "../routes/catalog";
import type { Env } from "../types";
import type {
  ControlPlaneHonoEnv,
  ControlPlaneHost,
  PlatformExecutionContext,
  RouteModule,
} from "./hono-env";
import { finalizeRouteResponse, logRequest, withCorsAndTraceHeaders } from "./request-lifecycle";

export type {
  ControlPlaneHonoEnv,
  ControlPlaneHost,
  PlatformExecutionContext,
  RouteModule,
} from "./hono-env";

/** Ordinary HTTP entrypoint signature shared by the Worker and test adapters. */
export type ControlPlaneHttpHandler = (
  request: Request,
  env: Env,
  executionCtx: ExecutionContext
) => Promise<Response>;

const logger = createLogger("router");

/**
 * Hono gives `*`, `?`, `{...}` and `.` routing meaning, and admission reads
 * raw parameter segments back from the pathname by position, so a path may
 * hold only literal and `:param` segments.
 */
const ROUTE_PATH_GRAMMAR = /^(\/([A-Za-z0-9_-]+|:\w+))+$/;

function assertRoutePath(method: string, path: string): void {
  if (!ROUTE_PATH_GRAMMAR.test(path)) {
    throw new Error(`Route path is outside the supported grammar: ${method} ${path}`);
  }
  const names = path.split("/").filter((segment) => segment.startsWith(":"));
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) {
    throw new Error(`Route declares parameter ${duplicate} twice: ${method} ${path}`);
  }
}

/**
 * Refuse a module unless every route it registers begins with `admit()`.
 *
 * Hono runs a route's handlers in registration order and stops at the first
 * one that answers, so a handler registered ahead of the policy, or with no
 * policy at all, would run its side effects before the lifecycle's default
 * deny could replace the response. Module-level middleware (`app.use`) is
 * refused for the same reason: nothing in a module runs before admission.
 */
function assertModuleAdmits(module: Hono<ControlPlaneHonoEnv>): void {
  const first = new Map<string, RouterRoute>();
  for (const route of module.routes) {
    if (route.method === "ALL") {
      throw new Error(`Module registers middleware outside admit(): ${route.path}`);
    }
    const identity = `${route.method} ${route.path}`;
    if (!first.has(identity)) first.set(identity, route);
  }
  for (const [identity, route] of first) {
    if (!("policy" in route.handler)) {
      throw new Error(`Module route does not begin with admit(): ${identity}`);
    }
    assertRoutePath(route.method, route.path);
  }
}

/** Mount a module, refusing it before it can serve a request. */
function mount(app: Hono<ControlPlaneHonoEnv>, module: RouteModule): void {
  assertModuleAdmits(module);
  app.route("/", module);
}

/** The execution context the platform passed to `app.fetch`, if any. */
function executionContextOf(c: {
  executionCtx: PlatformExecutionContext;
}): PlatformExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/**
 * Replace the response once the handler chain has finished. Hono's setter
 * merges the previous response's headers into the new one, so clear it
 * first when the previous response must not leak into the replacement.
 */
function replaceResponse(
  c: { res: Response | undefined; finalized: boolean },
  response: Response
): void {
  c.res = undefined;
  c.res = response;
}

/**
 * Build the Hono application over route modules, mounted in precedence order.
 *
 * The lifecycle middleware owns everything around a route: the DB and HEAD
 * guards, the request context, the request log, authorization audit, and
 * the common response headers. `admit()` owns the route's policy, and a
 * handler that answers without admission having run is refused.
 */
export function createControlPlaneApp(
  modules: readonly RouteModule[],
  host: ControlPlaneHost
): Hono<ControlPlaneHonoEnv> {
  const app = new Hono<ControlPlaneHonoEnv>({
    strict: true,
    getPath: (request) => new URL(request.url).pathname,
    router: new TrieRouter(),
  });

  app.use("*", async (c, next) => {
    // TrieRouter runs a root wildcard twice for the literal path `/*`.
    if (c.get("requestContext")) return next();

    const startedAt = Date.now();
    const pathname = c.req.path;
    const method = c.req.raw.method;

    // eslint-disable-next-line no-restricted-syntax -- composition root validates the required binding
    if (!c.env.DB) {
      logger.error("DB binding is not configured; refusing request", { http_path: pathname });
      return new Response(JSON.stringify({ error: "Database not configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const context = contextFor(c.req.raw, c.env, host.backgroundTasks(executionContextOf(c)));
    c.set("requestContext", context);
    c.set("startedAt", startedAt);

    // Hono maps HEAD to GET implicitly; the control plane never has.
    if (method === "HEAD") return withCorsAndTraceHeaders(error("Not found", 404), context);

    let unexpected = false;
    try {
      await next();
    } catch (caught) {
      // Only Error instances reach onError; anything else lands here.
      unexpected = true;
      replaceResponse(c, internalError(caught, context, method, pathname, startedAt));
    }
    // An unexpected handler failure was already logged as the 500 it became.
    unexpected ||= c.error !== undefined && !(c.error instanceof HttpError);

    const admission = c.get("admission");
    if (!admission) {
      if (c.get("admissionExempt")) return;
      if (unexpected) {
        // Admission itself failed: the 500 still carries the selected
        // route's response policy and the common headers.
        replaceResponse(c, finalizeRouteResponse(c.res, c.get("routePolicy") ?? {}, context));
        return;
      }
      logger.error("Handler answered without admission running ahead of it", {
        event: "router.unadmitted_response",
        http_method: method,
        http_path: pathname,
        request_id: context.request_id,
        trace_id: context.trace_id,
      });
      replaceResponse(c, withCorsAndTraceHeaders(error("Internal server error", 500), context));
      return;
    }

    const { policy, result } = admission;
    if (result.kind === "denied") {
      if (result.requestLog === "emit") logRequest(c.res, context, method, pathname, startedAt);
      replaceResponse(c, finalizeRouteResponse(c.res, policy, context));
      return;
    }

    if (!unexpected) logRequest(c.res, context, method, pathname, startedAt);
    if (shouldAuditAllowedDecision(result.decision)) {
      await auditRouteAuthorizationDecision({
        ctx: context,
        method,
        path: pathname,
        response: c.res,
        decision: result.decision,
      });
    }
    replaceResponse(c, finalizeRouteResponse(c.res, policy, context));
  });

  app.onError((caught, c) => {
    if (caught instanceof HttpError) return error(caught.message, caught.status);
    return internalError(
      caught,
      c.get("requestContext"),
      c.req.raw.method,
      c.req.path,
      c.get("startedAt")
    );
  });

  app.options("*", (c) => {
    c.set("admissionExempt", true);
    const context = c.get("requestContext");
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
        "x-request-id": context.request_id,
        "x-trace-id": context.trace_id,
      },
    });
  });

  for (const module of modules) mount(app, module);

  app.notFound((c) => {
    c.set("admissionExempt", true);
    return withCorsAndTraceHeaders(error("Not found", 404), c.get("requestContext"));
  });

  return app;
}

function contextFor(request: Request, env: Env, executionCtx: RequestContext["executionCtx"]) {
  // eslint-disable-next-line no-restricted-syntax -- ordinary HTTP composition root passes the stable binding once
  const database = env.DB;
  return createRequestContext({ request, env, database, executionCtx });
}

/** Log an unexpected failure as the sanitized 500 it becomes. */
function internalError(
  caught: unknown,
  context: RequestContext,
  method: string,
  pathname: string,
  startedAt: number
): Response {
  logger.error("http.request", {
    event: "http.request",
    request_id: context.request_id,
    trace_id: context.trace_id,
    http_method: method,
    http_path: pathname,
    http_status: 500,
    duration_ms: Date.now() - startedAt,
    outcome: "error",
    error: caught instanceof Error ? caught : String(caught),
    ...context.metrics.summarize(),
  });
  return error("Internal server error", 500);
}

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
