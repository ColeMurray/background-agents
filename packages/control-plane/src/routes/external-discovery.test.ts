import { listRouteContracts } from "../routing/route-contracts";
import { describe, expect, it } from "vitest";
import { externalDiscoveryRoutes } from "./external-discovery";

const contracts = listRouteContracts(externalDiscoveryRoutes);

describe("external discovery route policy", () => {
  it("defines only the six V1 read routes with human-user authentication", () => {
    expect(
      contracts.map((route) => ({
        method: route.method,
        path: route.path,
        authentication: route.authentication.kind,
        scm: route.supportedScmProviders,
        cacheControl: route.cacheControl,
      }))
    ).toEqual([
      {
        method: "GET",
        path: "/external/v1/repositories",
        authentication: "user",
        scm: "all",
        cacheControl: "private, no-store",
      },
      {
        method: "GET",
        path: "/external/v1/environments",
        authentication: "user",
        scm: "all",
        cacheControl: "private, no-store",
      },
      {
        method: "GET",
        path: "/external/v1/environments/:id",
        authentication: "user",
        scm: "all",
        cacheControl: "private, no-store",
      },
      {
        method: "GET",
        path: "/external/v1/models",
        authentication: "user",
        scm: "all",
        cacheControl: "private, no-store",
      },
      {
        method: "GET",
        path: "/external/v1/skills",
        authentication: "user",
        scm: "all",
        cacheControl: "private, no-store",
      },
      {
        method: "GET",
        path: "/external/v1/provider-accounts",
        authentication: "user",
        scm: "all",
        cacheControl: "private, no-store",
      },
    ]);
  });

  it("assigns the required RBAC policies", () => {
    expect(contracts.map((route) => route.authorization)).toMatchObject([
      { kind: "active-user", allOf: [{ permission: "repositories.read" }] },
      { kind: "active-user", allOf: [{ permission: "environments.read" }] },
      { kind: "active-user", allOf: [{ permission: "environments.read" }] },
      { kind: "active-global" },
      {
        kind: "active-user",
        allOf: [{ permission: "skills.read" }],
      },
      { kind: "active-user", allOf: [{ permission: "provider_accounts.read" }] },
    ]);
  });
});
