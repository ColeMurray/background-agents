import { describe, expect, it } from "vitest";
import {
  buildSessionsHref,
  DEFAULT_SESSION_DISCOVERY_QUERY,
  hasSessionDiscoveryFilters,
  parseSessionDiscoveryQuery,
  serializeSessionDiscoveryQuery,
  toSessionListQuery,
  type SessionDiscoveryQuery,
} from "./session-discovery";

const fullQuery: SessionDiscoveryQuery = {
  q: "login",
  creator: "mine",
  repository: { repoOwner: "group/subgroup", repoName: "service" },
  environmentId: "env-1",
  lifecycle: "archived",
  origin: "automation",
};

describe("session discovery URL state", () => {
  it("parses /sessions with no parameters as the default view", () => {
    expect(parseSessionDiscoveryQuery(new URLSearchParams())).toEqual({
      success: true,
      data: DEFAULT_SESSION_DISCOVERY_QUERY,
    });
    expect(hasSessionDiscoveryFilters(DEFAULT_SESSION_DISCOVERY_QUERY)).toBe(false);
    expect(buildSessionsHref()).toBe("/sessions");
  });

  it("round-trips every control through the URL", () => {
    const serialized = serializeSessionDiscoveryQuery(fullQuery).toString();
    expect(serialized).toBe(
      "q=login&createdBy=me&repoOwner=group%2Fsubgroup&repoName=service&environmentId=env-1&lifecycle=archived&origin=automation"
    );
    expect(parseSessionDiscoveryQuery(new URLSearchParams(serialized))).toEqual({
      success: true,
      data: fullQuery,
    });
    expect(hasSessionDiscoveryFilters(fullQuery)).toBe(true);
  });

  it("treats blank values as absent and trims search text", () => {
    expect(
      parseSessionDiscoveryQuery(new URLSearchParams("q=%20trim%20&origin=&lifecycle=&createdBy="))
    ).toEqual({ success: false, invalidParams: ["createdBy", "lifecycle"] });
    expect(parseSessionDiscoveryQuery(new URLSearchParams("q=%20trim%20&origin="))).toEqual({
      success: true,
      data: { ...DEFAULT_SESSION_DISCOVERY_QUERY, q: "trim" },
    });
  });

  it.each([
    ["an oversized search", `q=${"x".repeat(201)}`, ["q"]],
    ["a creator other than me", "createdBy=ffffffffffffffffffffffffffffffff", ["createdBy"]],
    ["a repository owner without a name", "repoOwner=acme", ["repoName"]],
    ["a repository name without an owner", "repoName=web-app", ["repoOwner"]],
    ["a blank repository owner", "repoOwner=%20&repoName=web-app", ["repoOwner"]],
    ["a blank environment", "environmentId=%20", ["environmentId"]],
    ["an oversized environment", `environmentId=${"e".repeat(257)}`, ["environmentId"]],
    ["an oversized repository name", `repoOwner=acme&repoName=${"n".repeat(257)}`, ["repoName"]],
    ["an unknown lifecycle", "lifecycle=deleted", ["lifecycle"]],
    ["an unknown origin", "origin=automations", ["origin"]],
  ])("refuses %s instead of widening the view", (_label, url, invalidParams) => {
    expect(parseSessionDiscoveryQuery(new URLSearchParams(url))).toEqual({
      success: false,
      invalidParams,
    });
  });

  it("refuses parameters the page has no control for, even ones the API accepts", () => {
    // `status=archived` is a valid API filter, but this page expresses lifecycle
    // through `lifecycle`; honouring it would render a view the URL misnames.
    expect(
      parseSessionDiscoveryQuery(new URLSearchParams("status=archived&limit=5&utm_source=x"))
    ).toEqual({ success: false, invalidParams: ["status", "limit", "utm_source"] });
  });

  it("refuses repeated parameters", () => {
    expect(parseSessionDiscoveryQuery(new URLSearchParams("q=a&q=b&createdBy=me"))).toEqual({
      success: false,
      invalidParams: ["q"],
    });
    expect(parseSessionDiscoveryQuery(new URLSearchParams("createdBy=me&createdBy=me"))).toEqual({
      success: false,
      invalidParams: ["createdBy"],
    });
  });

  it("reports every refused parameter of one link", () => {
    expect(
      parseSessionDiscoveryQuery(new URLSearchParams("status=archived&lifecycle=deleted&origin=x"))
    ).toEqual({ success: false, invalidParams: ["status", "origin", "lifecycle"] });
  });

  it("builds shareable hrefs from partial state", () => {
    expect(buildSessionsHref({ lifecycle: "archived" })).toBe("/sessions?lifecycle=archived");
    expect(buildSessionsHref({ q: " fix login " })).toBe("/sessions?q=fix+login");
    expect(buildSessionsHref({ lifecycle: "nonarchived", creator: "all" })).toBe("/sessions");
  });

  it("maps the page state onto the shared list-query contract", () => {
    expect(toSessionListQuery(DEFAULT_SESSION_DISCOVERY_QUERY, { limit: 50, offset: 0 })).toEqual({
      limit: 50,
      offset: 0,
      excludeStatus: "archived",
    });
    expect(toSessionListQuery(fullQuery, { limit: 50, offset: 100 })).toEqual({
      limit: 50,
      offset: 100,
      status: "archived",
      createdBy: ["me"],
      q: "login",
      repoOwner: "group/subgroup",
      repoName: "service",
      environmentId: "env-1",
      origin: "automation",
    });
    expect(
      toSessionListQuery({ ...fullQuery, lifecycle: "all" }, { limit: 50, offset: 0 })
    ).toEqual(
      expect.not.objectContaining({ status: expect.anything(), excludeStatus: expect.anything() })
    );
  });
});
