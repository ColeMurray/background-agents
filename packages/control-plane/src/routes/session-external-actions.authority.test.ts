import { describe, expect, it } from "vitest";
import { listRouteContracts } from "../routing/route-contracts";
import { createControlPlaneApp } from "../routing/hono-app";
import { catalog } from "./catalog";
import { cloudflareHost } from "../cloudflare/http-host";

const routes = listRouteContracts(createControlPlaneApp(catalog, cloudflareHost));

function routeFor(method: string, path: string) {
  return routes.find((route) => route.method === method && route.path === path);
}

describe("external action route authority", () => {
  it("requires action authority, not read authority, to decide an external effect", () => {
    const route = routeFor("POST", "/sessions/:id/external-actions/:actionId/decision");
    expect(route).toBeDefined();
    const authorization = route?.authorization;
    expect(authorization?.kind).toBe("active-user");
    if (authorization?.kind !== "active-user") throw new Error("unexpected authorization kind");
    const sessionRequirements = authorization.allOf.filter((entry) => entry.kind === "session");
    expect(sessionRequirements).toEqual([
      { kind: "session", sessionIdParam: "id", action: "collaborate" },
    ]);
    expect(
      authorization.allOf.some(
        (entry) => entry.kind === "permission" && entry.permission === "external_actions.approve"
      )
    ).toBe(true);
  });

  it("keeps read authority for the status route", () => {
    const route = routeFor("GET", "/sessions/:id/external-actions/:actionId");
    const authorization = route?.authorization;
    expect(authorization?.kind).toBe("active-user");
    if (authorization?.kind !== "active-user") throw new Error("unexpected authorization kind");
    expect(authorization.allOf).toEqual([
      { kind: "session", sessionIdParam: "id", action: "read" },
    ]);
  });

  it("exposes a pending-action list that needs only read authority", () => {
    const route = routeFor("GET", "/sessions/:id/external-actions");
    expect(route).toBeDefined();
    const authorization = route?.authorization;
    expect(authorization?.kind).toBe("active-user");
    if (authorization?.kind !== "active-user") throw new Error("unexpected authorization kind");
    expect(authorization.allOf).toEqual([
      { kind: "session", sessionIdParam: "id", action: "read" },
    ]);
  });
});
