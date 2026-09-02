/** Hono adapter for ordinary control-plane HTTP requests. */

import { Hono } from "hono";
import { TrieRouter } from "hono/router/trie-router";
import { createCloudflareBackgroundTasks } from "../cloudflare/background-tasks";
import { createRequestContext } from "../http/create-request-context";
import type { RequestContext } from "../http/request-context";
import { error } from "../http/responses";
import { createLogger } from "../logger";
import { routes } from "../routes/catalog";
import type { Route } from "../routes/shared";
import { dispatchMatchedRoute } from "./route-dispatch";
import { withCorsAndTraceHeaders } from "./request-lifecycle";
import type { Env } from "../types";

type ControlPlaneHonoEnv = {
  Bindings: Env;
  Variables: {
    requestContext: RequestContext;
    startedAt: number;
  };
};

/** Ordinary HTTP entrypoint signature shared by the Worker and test adapters. */
export type ControlPlaneHttpHandler = (
  request: Request,
  env: Env,
  executionCtx: ExecutionContext
) => Promise<Response>;

const logger = createLogger("router");

/**
 * Hono gives `*`, `?`, `{...}` and `.` routing meaning that parsePattern
 * compiles as literals. Refusing anything outside literal or `:param`
 * segments keeps Hono selection and the raw-path regex in agreement.
 */
const ROUTE_PATH_GRAMMAR = /^(\/([A-Za-z0-9_-]+|:\w+))+$/;

/** Wall-clock start captured before Hono selects a route, keyed by the raw request. */
const requestStartedAt = new WeakMap<Request, number>();

function assertRouteContract(route: Route): void {
  if (!ROUTE_PATH_GRAMMAR.test(route.path)) {
    throw new Error(`Route path is outside the supported grammar: ${route.method} ${route.path}`);
  }
  const principalless =
    route.authentication.kind === "public" || route.authentication.kind === "handler-authenticated";
  if (principalless && route.authorization.kind !== "none") {
    throw new Error(
      `Route without a verified principal cannot require authorization: ${route.method} ${route.path}`
    );
  }
}

function contextFor(
  request: Request,
  env: Env,
  executionCtx: Parameters<typeof createCloudflareBackgroundTasks>[0]
): RequestContext {
  // eslint-disable-next-line no-restricted-syntax -- ordinary HTTP composition root passes the stable binding once
  const database = env.DB;
  return createRequestContext({
    request,
    env,
    database,
    executionCtx: createCloudflareBackgroundTasks(executionCtx),
  });
}

function createHonoApp(catalog: readonly Route[]): Hono<ControlPlaneHonoEnv> {
  for (const route of catalog) assertRouteContract(route);

  const app = new Hono<ControlPlaneHonoEnv>({
    strict: true,
    getPath: (request) => new URL(request.url).pathname,
    router: new TrieRouter(),
  });

  app.onError((caught) => {
    throw caught;
  });

  app.use("*", async (c, next) => {
    // TrieRouter runs a root wildcard twice for the literal path `/*`.
    if (c.get("requestContext")) return next();
    c.set("requestContext", contextFor(c.req.raw, c.env, c.executionCtx));
    c.set("startedAt", requestStartedAt.get(c.req.raw) ?? Date.now());
    await next();
  });

  app.options("*", (c) => {
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

  for (const route of catalog) {
    app.on(route.method, route.path, async (c) => {
      const pathname = new URL(c.req.raw.url).pathname;
      const match = pathname.match(route.pattern);
      const context = c.get("requestContext");
      if (!match) {
        // Unreachable while the grammar guard holds; fail closed but loudly.
        logger.error("Hono selected a route its raw-path matcher rejects", {
          event: "router.match_mismatch",
          http_method: route.method,
          route_path: route.path,
          http_path: pathname,
          request_id: context.request_id,
          trace_id: context.trace_id,
        });
        return withCorsAndTraceHeaders(error("Not found", 404), context);
      }

      return dispatchMatchedRoute({
        request: c.req.raw,
        env: c.env,
        route,
        match,
        pathname,
        context,
        startedAt: c.get("startedAt"),
      });
    });
  }

  app.notFound((c) => withCorsAndTraceHeaders(error("Not found", 404), c.get("requestContext")));

  return app;
}

/**
 * Build the ordinary HTTP entrypoint over a route catalog.
 *
 * DB and HEAD handling stay outside Hono because missing-DB responses are
 * intentionally undecorated and Hono implicitly maps HEAD to GET.
 */
export function createControlPlaneHttpHandler(catalog: readonly Route[]): ControlPlaneHttpHandler {
  const app = createHonoApp(catalog);

  return async (request, env, executionCtx) => {
    requestStartedAt.set(request, Date.now());
    const pathname = new URL(request.url).pathname;

    // eslint-disable-next-line no-restricted-syntax -- ordinary HTTP composition root validates the required binding
    if (!env.DB) {
      logger.error("DB binding is not configured; refusing request", { http_path: pathname });
      return new Response(JSON.stringify({ error: "Database not configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "HEAD") {
      return withCorsAndTraceHeaders(
        error("Not found", 404),
        contextFor(request, env, executionCtx)
      );
    }

    return app.fetch(request, env, executionCtx);
  };
}

/** Production entrypoint over the canonical route catalog. */
export const handleControlPlaneHttp: ControlPlaneHttpHandler =
  createControlPlaneHttpHandler(routes);
