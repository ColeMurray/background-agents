import { describe, expect, it } from "vitest";
import { serializeSessionListQuery } from "@open-inspect/shared/session-list-query";
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
  ...DEFAULT_SESSION_DISCOVERY_QUERY,
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

  it("round-trips repeated teams, owner and visibility without replacing Creator Mine", () => {
    const query: SessionDiscoveryQuery = {
      ...fullQuery,
      teamIds: ["team_alpha", "team_beta"],
      scope: "all",
      ownerFilter: "participating",
      visibility: "private",
    };
    const params = serializeSessionDiscoveryQuery(query);
    expect(params.getAll("teamIds[]")).toEqual(["team_alpha", "team_beta"]);
    expect(params.get("ownerFilter")).toBe("participating");
    expect(params.get("visibility")).toBe("private");
    expect(params.get("scope")).toBe("all");
    expect(params.get("createdBy")).toBe("me");
    expect(parseSessionDiscoveryQuery(params)).toEqual({ success: true, data: query });
    expect(toSessionListQuery(query, { limit: 50, offset: 50 })).toMatchObject({
      teamIds: ["team_alpha", "team_beta"],
      ownerFilter: "participating",
      visibility: "private",
      scope: "all",
      createdBy: ["me"],
      offset: 50,
    });
    expect(buildSessionsHref(query)).toBe(`/sessions?${params}`);
  });

  it("keeps explicit Owner Anyone from overriding Creator Mine's started-by-me API semantics", () => {
    const parsed = parseSessionDiscoveryQuery(
      new URLSearchParams("createdBy=me&ownerFilter=anyone")
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Expected a valid Mine link");
    const params = serializeSessionListQuery(
      toSessionListQuery(parsed.data, { limit: 50, offset: 0 })
    );
    expect(params.getAll("createdBy")).toEqual(["me"]);
    expect(params.has("ownerFilter")).toBe(false);
  });

  it.each(["started", "participating", "anyone"] as const)("accepts Owner %s", (ownerFilter) => {
    expect(parseSessionDiscoveryQuery(new URLSearchParams({ ownerFilter }))).toEqual({
      success: true,
      data: { ...DEFAULT_SESSION_DISCOVERY_QUERY, ownerFilter },
    });
  });

  it.each(["team", "workspace", "private"] as const)("accepts Visibility %s", (visibility) => {
    expect(parseSessionDiscoveryQuery(new URLSearchParams({ visibility }))).toEqual({
      success: true,
      data: { ...DEFAULT_SESSION_DISCOVERY_QUERY, visibility },
    });
  });

  it("uses the shared team-ID validation and deduplicates at most 50 selected teams", () => {
    const teamIds = Array.from({ length: 50 }, (_, index) => `team_${index}`);
    const params = new URLSearchParams(teamIds.map((id) => ["teamIds[]", id]));
    params.append("teamIds[]", "team_0");
    expect(parseSessionDiscoveryQuery(params)).toEqual({
      success: true,
      data: { ...DEFAULT_SESSION_DISCOVERY_QUERY, teamIds },
    });
    params.append("teamIds[]", "team_50");
    expect(parseSessionDiscoveryQuery(params)).toEqual({
      success: false,
      invalidParams: ["teamIds[]"],
    });
  });

  it.each([
    ["teamIds[]=unknown", "teamIds[]"],
    ["teamIds[]=", "teamIds[]"],
    ["teamIds[]=team_good&teamIds[]=bad", "teamIds[]"],
    ["ownerFilter=mine", "ownerFilter"],
    ["ownerFilter=started&ownerFilter=participating", "ownerFilter"],
    ["visibility=public", "visibility"],
    ["visibility=", "visibility"],
    ["visibility=team&visibility=private", "visibility"],
    ["scope=mine", "scope"],
    ["scope=", "scope"],
    ["scope=workspace&scope=all", "scope"],
  ])("refuses invalid or repeated team filters: %s", (url, invalidParam) => {
    expect(parseSessionDiscoveryQuery(new URLSearchParams(url))).toEqual({
      success: false,
      invalidParams: [invalidParam],
    });
  });

  it.each([
    [null, { teamIds: undefined, scope: "workspace" }],
    ["all-my-teams", { teamIds: undefined, scope: undefined }],
    ["all-teams", { teamIds: undefined, scope: "all" }],
    ["team_alpha", { teamIds: ["team_alpha"], scope: undefined }],
  ])("maps active context %s onto the shared team predicate", (activeTeamId, predicate) => {
    expect(buildSessionsHref(predicate as Partial<SessionDiscoveryQuery>)).toBe(
      activeTeamId === null
        ? "/sessions?scope=workspace"
        : activeTeamId === "all-teams"
          ? "/sessions?scope=all"
          : activeTeamId === "all-my-teams"
            ? "/sessions"
            : "/sessions?teamIds%5B%5D=team_alpha"
    );
  });
});
