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

  it("reports every value the API would reject instead of widening the view", () => {
    expect(
      parseSessionDiscoveryQuery(
        new URLSearchParams(
          `q=${"x".repeat(201)}&createdBy=ffffffffffffffffffffffffffffffff&repoOwner=acme&environmentId=%20&lifecycle=deleted&origin=automations`
        )
      )
    ).toEqual({
      success: false,
      invalidParams: ["q", "createdBy", "repoName", "environmentId", "lifecycle", "origin"],
    });
    expect(parseSessionDiscoveryQuery(new URLSearchParams("repoName=web-app"))).toEqual({
      success: false,
      invalidParams: ["repoOwner"],
    });
    expect(
      parseSessionDiscoveryQuery(new URLSearchParams("repoOwner=%20&repoName=web-app"))
    ).toEqual({ success: false, invalidParams: ["repoOwner"] });
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
