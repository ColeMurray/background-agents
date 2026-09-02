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

  it("accepts an app whose every route carries a tagged policy somewhere in its chain", () => {
    const sub = new Hono();
    sub.post("/c", passThrough, admit(), ok);

    const app = new Hono();
    app.use("*", passThrough);
    app.options("*", ok);
    app.get("/a/:id", admit(), ok);
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
      "Routes registered without an admission policy: GET /b, POST /sub/c"
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

  // The catalog adapter registers each route's handler directly, so nothing is
  // tagged yet. This flips when admit() lands: drop `.fails` in the same change.
  it.fails("every production route registers an admission policy", () => {
    assertEveryRouteAdmits(createControlPlaneApp(routes), { exempt: ["OPTIONS /*"] });
  });
});
