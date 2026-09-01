import { describe, expect, it } from "vitest";
import { externalDiscoveryRoutes } from "./external-discovery";

describe("external discovery route policy", () => {
  it("defines only the six V1 read routes with external-user authentication", () => {
    expect(
      externalDiscoveryRoutes.map((route) => ({
        method: route.method,
        pattern: route.pattern.source,
        authentication: route.authentication.kind,
        scm: route.supportedScmProviders,
        cacheControl: route.cacheControl,
      }))
    ).toEqual([
      {
        method: "GET",
        pattern: "^\\/external\\/v1\\/repositories$",
        authentication: "external-user",
        scm: "all",
        cacheControl: "private, no-store",
      },
      {
        method: "GET",
        pattern: "^\\/external\\/v1\\/environments$",
        authentication: "external-user",
        scm: "all",
        cacheControl: "private, no-store",
      },
      {
        method: "GET",
        pattern: "^\\/external\\/v1\\/environments\\/(?<id>[^/]+)$",
        authentication: "external-user",
        scm: "all",
        cacheControl: "private, no-store",
      },
      {
        method: "GET",
        pattern: "^\\/external\\/v1\\/models$",
        authentication: "external-user",
        scm: "all",
        cacheControl: "private, no-store",
      },
      {
        method: "GET",
        pattern: "^\\/external\\/v1\\/skills$",
        authentication: "external-user",
        scm: "all",
        cacheControl: "private, no-store",
      },
      {
        method: "GET",
        pattern: "^\\/external\\/v1\\/provider-accounts$",
        authentication: "external-user",
        scm: "all",
        cacheControl: "private, no-store",
      },
    ]);
  });

  it("assigns the required RBAC policies", () => {
    expect(externalDiscoveryRoutes.map((route) => route.authorization)).toMatchObject([
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
