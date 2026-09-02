import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { describe, expect, it } from "vitest";
import { routes } from "../routes/catalog";
import { NO_AUTHORIZATION, type RouteAdmissionPolicy } from "../routes/shared";
import { createControlPlaneApp } from "./hono-app";
import {
  assertEveryRouteAdmits,
  missingRoutePolicies,
  registerRoutePolicy,
  routePolicyOf,
} from "./route-policy-registry";

const PUBLIC_POLICY: RouteAdmissionPolicy = {
  authentication: { kind: "public" },
  authorization: NO_AUTHORIZATION,
  supportedScmProviders: "all",
};

/** Untagged middleware, standing in for anything that is not an admission step. */
const passThrough = createMiddleware(async (_c, next) => next());

function admit(policy: RouteAdmissionPolicy = PUBLIC_POLICY) {
  return registerRoutePolicy(
    createMiddleware(async (_c, next) => next()),
    policy
  );
}

const ok = () => new Response("ok");

describe("route policy registry", () => {
  it("returns the tagged middleware and recalls its policy", () => {
    const middleware = admit();
    expect(routePolicyOf(middleware)).toBe(PUBLIC_POLICY);
    expect(routePolicyOf(passThrough)).toBeUndefined();
  });

  it("accepts an app whose every route chain begins with a tagged policy", () => {
    const sub = new Hono();
    sub.post("/c", admit(), passThrough, ok);

    const app = new Hono();
    app.use("*", passThrough);
    app.options("*", ok);
    app.get("/a/:id", admit(), ok);
    app.get("/a/:id", ok);
    app.route("/sub", sub);

    expect(missingRoutePolicies(app, { exempt: ["OPTIONS /*"] })).toEqual([]);
    expect(() => assertEveryRouteAdmits(app, { exempt: ["OPTIONS /*"] })).not.toThrow();
  });

  it("names every method+path registered without a policy, once each", () => {
    const sub = new Hono();
    sub.post("/c", passThrough, ok);

    const app = new Hono();
    app.get("/a", admit(), ok);
    app.get("/b", passThrough, ok);
    app.get("/b", ok);
    app.route("/sub", sub);

    expect(missingRoutePolicies(app)).toEqual(["GET /b", "POST /sub/c"]);
    expect(() => assertEveryRouteAdmits(app)).toThrow(
      "Routes whose handler chain does not begin with an admission policy: GET /b, POST /sub/c"
    );
  });

  it("does not credit a policy tagged on another method or path", () => {
    const app = new Hono();
    const shared = admit();
    app.get("/a", shared, ok);
    app.post("/a", ok);
    app.get("/b", ok);

    expect(missingRoutePolicies(app)).toEqual(["POST /a", "GET /b"]);
  });

  it("refuses a policy that an earlier handler for the same method+path can pre-empt", async () => {
    // Hono stops at the first handler that returns without calling next, so
    // a policy registered behind it never runs.
    const later = new Hono();
    later.get("/a", ok);
    later.get("/a", admit(), ok);
    expect(missingRoutePolicies(later)).toEqual(["GET /a"]);
    expect(await (await later.request("/a")).text()).toBe("ok");

    const trailing = new Hono();
    trailing.get("/a", ok, admit());
    expect(missingRoutePolicies(trailing)).toEqual(["GET /a"]);

    // Untagged middleware ahead of the policy is refused too: the check does
    // not try to tell a pass-through from a handler that answers.
    const preceded = new Hono();
    preceded.get("/a", passThrough, admit(), ok);
    expect(missingRoutePolicies(preceded)).toEqual(["GET /a"]);
  });

  it("credits a policy wrapped by a mounted sub-app that owns an error handler", () => {
    const sub = new Hono();
    sub.onError((_error, c) => c.text("sub error", 500));
    sub.get("/x", admit(), ok);

    const app = new Hono();
    app.route("/s", sub);

    const entry = app.routes.find((route) => route.path === "/s/x");
    expect(entry).toBeDefined();
    expect(routePolicyOf(entry!.handler)).toBe(PUBLIC_POLICY);
    expect(missingRoutePolicies(app)).toEqual([]);
  });

  it("ignores app.use middleware and honours the exempt list", () => {
    const app = new Hono();
    app.use("*", passThrough);
    app.use("/a/*", admit());
    app.get("/a/x", ok);
    app.options("*", ok);

    // A policy on a use() prefix is not a policy on the route itself.
    expect(missingRoutePolicies(app)).toEqual(["GET /a/x", "OPTIONS /*"]);
    expect(missingRoutePolicies(app, { exempt: ["OPTIONS /*", "GET /a/x"] })).toEqual([]);
  });

  // The catalog adapter registers each route's handler directly, so no
  // production route is tagged yet. This pins that exact state; the change
  // that lands admit() shrinks the expected list to empty.
  it("reports every production route as untagged until admit() lands", () => {
    const app = createControlPlaneApp(routes);
    expect(missingRoutePolicies(app, { exempt: ["OPTIONS /*"] })).toEqual(
      routes.map((route) => `${route.method} ${route.path}`)
    );
  });
});
