/** Hono application for ordinary control-plane HTTP requests. */

import { Hono, type Handler } from "hono";
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
import type { Route, RouteParams } from "../routes/shared";
import type { Env } from "../types";
import { admit } from "./admit";
import type {
  ControlPlaneHonoEnv,
  ControlPlaneHost,
  PlatformExecutionContext,
  RouteCatalogEntry,
} from "./hono-env";
import { finalizeRouteResponse, logRequest, withCorsAndTraceHeaders } from "./request-lifecycle";

export type {
  ControlPlaneHonoEnv,
  ControlPlaneHost,
  PlatformExecutionContext,
  RouteCatalogEntry,
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
 * Hono gives `*`, `?`, `{...}` and `.` routing meaning, and raw parameter
 * segments are read back from the pathname by position, so a path may hold
 * only literal and `:param` segments.
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

/** Mount a module or register a legacy route, refusing either before it can serve a request. */
function register(app: Hono<ControlPlaneHonoEnv>, entry: RouteCatalogEntry): void {
  if (entry instanceof Hono) {
    assertModuleAdmits(entry);
    app.route("/", entry);
    return;
  }
  assertRoutePath(entry.method, entry.path);
  app.on(entry.method, entry.path, admit(entry), legacy(entry));
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

/** Rebuild the legacy `RegExpMatchArray` handlers still read from raw parameters. */
function legacyMatch(pathname: string, params: RouteParams): RegExpMatchArray {
  const match = [pathname, ...Object.values(params)] as unknown as RegExpMatchArray;
  match.index = 0;
  match.input = pathname;
  match.groups = { ...params };
  return match;
}

/** Run a catalog handler with the request and context admission produced. */
function legacy(route: Route): Handler<ControlPlaneHonoEnv> {
  return (c) => {
    const admission = c.get("admission");
    if (admission?.result.kind !== "admitted") {
      throw new Error(`Handler reached without admission: ${route.method} ${route.path}`);
    }
    return route.handler(
      admission.result.handlerRequest,
      c.env,
      legacyMatch(c.req.path, admission.params),
      c.get("requestContext")
    );
  };
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
 * Build the Hono application over a route catalog.
 *
 * The lifecycle middleware owns everything around a route: the DB and HEAD
 * guards, the request context, the request log, authorization audit, and
 * the common response headers. `admit()` owns the route's policy, and a
 * handler that answers without admission having run is refused.
 */
export function createControlPlaneApp(
  entries: readonly RouteCatalogEntry[],
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

  for (const entry of entries) register(app, entry);

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

/** Build the Worker's ordinary HTTP entrypoint over a route catalog. */
export function createControlPlaneHttpHandler(
  entries: readonly RouteCatalogEntry[]
): ControlPlaneHttpHandler {
  const app = createControlPlaneApp(entries, cloudflareHost);
  return (request, env, executionCtx) => Promise.resolve(app.fetch(request, env, executionCtx));
}

/** Production entrypoint over the canonical route catalog. */
export const handleControlPlaneHttp: ControlPlaneHttpHandler =
  createControlPlaneHttpHandler(catalog);
