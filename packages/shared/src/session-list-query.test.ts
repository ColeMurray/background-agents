import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_LIST_SEARCH_LENGTH,
  normalizeSessionListSearch,
  parseSessionListQuery,
  serializeSessionListQuery,
  SESSION_LIST_CURRENT_USER,
} from "./session-list-query";

describe("session list query codec", () => {
  it("serializes the typed query in stable cache-key order", () => {
    expect(
      serializeSessionListQuery({
        limit: 25,
        offset: 50,
        status: "active",
        excludeStatus: "archived",
        excludeAutomationLineage: true,
        createdBy: [SESSION_LIST_CURRENT_USER, "a".repeat(32)],
      }).toString()
    ).toBe(
      "limit=25&offset=50&status=active&excludeStatus=archived&excludeAutomationLineage=true&createdBy=me&createdBy=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("omits optional false and undefined filters", () => {
    expect(serializeSessionListQuery({ excludeAutomationLineage: false }).toString()).toBe("");
  });

  it("parses filters, repeated creators, and pagination", () => {
    expect(
      parseSessionListQuery(
        new URLSearchParams(
          "limit=25&offset=50&status=active&excludeStatus=archived&excludeAutomationLineage=false&createdBy=me&createdBy=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        )
      )
    ).toEqual({
      success: true,
      data: {
        limit: 25,
        offset: 50,
        status: "active",
        excludeStatus: "archived",
        excludeAutomationLineage: false,
        createdBy: ["me", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      },
    });
  });

  it("preserves pagination defaults, parseInt behavior, and bounds", () => {
    expect(parseSessionListQuery(new URLSearchParams())).toMatchObject({
      success: true,
      data: { limit: 50, offset: 0 },
    });
    expect(parseSessionListQuery(new URLSearchParams("limit=12px&offset=-2"))).toMatchObject({
      success: true,
      data: { limit: 12, offset: 0 },
    });
    expect(parseSessionListQuery(new URLSearchParams("limit=abc&offset=nope"))).toMatchObject({
      success: true,
      data: { limit: 50, offset: 0 },
    });
    expect(parseSessionListQuery(new URLSearchParams("limit=500"))).toMatchObject({
      success: true,
      data: { limit: 100, offset: 0 },
    });
    expect(parseSessionListQuery(new URLSearchParams("limit=0&offset=12px"))).toMatchObject({
      success: true,
      data: { limit: 1, offset: 12 },
    });
  });

  it("preserves empty status values as absent", () => {
    expect(parseSessionListQuery(new URLSearchParams("status=&excludeStatus="))).toMatchObject({
      success: true,
      data: { status: undefined, excludeStatus: undefined },
    });
  });

  it.each([
    ["status=unknown", "status"],
    ["excludeStatus=unknown", "excludeStatus"],
    ["excludeAutomationLineage=", "excludeAutomationLineage"],
    ["excludeAutomationLineage=1", "excludeAutomationLineage"],
    ["createdBy=not-a-user-id", "createdBy"],
  ] as const)("rejects invalid transport input %s", (query, invalidParam) => {
    expect(parseSessionListQuery(new URLSearchParams(query))).toEqual({
      success: false,
      invalidParam,
    });
  });

  it("preserves validation error precedence", () => {
    expect(
      parseSessionListQuery(
        new URLSearchParams(
          "status=unknown&excludeStatus=unknown&excludeAutomationLineage=1&createdBy=invalid"
        )
      )
    ).toEqual({ success: false, invalidParam: "status" });
  });
});

describe("session discovery query codec", () => {
  it("serializes search and discovery filters after the established params", () => {
    expect(
      serializeSessionListQuery({
        limit: 50,
        offset: 0,
        excludeStatus: "archived",
        createdBy: [SESSION_LIST_CURRENT_USER],
        q: "  fix login  ",
        repoOwner: "acme",
        repoName: "web-app",
        environmentId: "env-1",
        origin: "automation",
      }).toString()
    ).toBe(
      "limit=50&offset=0&excludeStatus=archived&createdBy=me&q=fix+login&repoOwner=acme&repoName=web-app&environmentId=env-1&origin=automation"
    );
  });

  it("omits blank search text and half-specified repositories", () => {
    expect(serializeSessionListQuery({ q: "   ", repoOwner: "acme" }).toString()).toBe("");
    expect(serializeSessionListQuery({ repoName: "web-app" }).toString()).toBe("");
  });

  it("parses trimmed search text and discovery filters", () => {
    expect(
      parseSessionListQuery(
        new URLSearchParams(
          "q=%20Fix%20Login%20&repoOwner=acme&repoName=web-app&environmentId=env-1&origin=github-bot"
        )
      )
    ).toEqual({
      success: true,
      data: {
        limit: 50,
        offset: 0,
        status: undefined,
        excludeStatus: undefined,
        excludeAutomationLineage: false,
        createdBy: [],
        q: "Fix Login",
        repoOwner: "acme",
        repoName: "web-app",
        environmentId: "env-1",
        origin: "github-bot",
      },
    });
  });

  it("treats blank search and identifier values as absent", () => {
    const parsed = parseSessionListQuery(
      new URLSearchParams("q=%20%20&repoOwner=&repoName=&environmentId=&origin=")
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).not.toHaveProperty("q");
    expect(parsed.data).not.toHaveProperty("repoOwner");
    expect(parsed.data).not.toHaveProperty("environmentId");
    expect(parsed.data).not.toHaveProperty("origin");
  });

  it("accepts search text up to the documented bound and rejects longer input", () => {
    const longest = "x".repeat(MAX_SESSION_LIST_SEARCH_LENGTH);
    expect(parseSessionListQuery(new URLSearchParams({ q: ` ${longest} ` }))).toMatchObject({
      success: true,
      data: { q: longest },
    });
    expect(parseSessionListQuery(new URLSearchParams({ q: `${longest}y` }))).toEqual({
      success: false,
      invalidParam: "q",
    });
    expect(normalizeSessionListSearch(`${longest}y`)).toBeNull();
    expect(normalizeSessionListSearch(undefined)).toBe("");
  });

  it.each([
    ["repoOwner=acme", "repoName"],
    ["repoName=web-app", "repoOwner"],
    ["repoOwner=%20&repoName=web-app", "repoOwner"],
    [`repoOwner=acme&repoName=${"n".repeat(257)}`, "repoName"],
    ["environmentId=%20", "environmentId"],
    ["origin=cron", "origin"],
  ] as const)("rejects the discovery input %s", (query, invalidParam) => {
    expect(parseSessionListQuery(new URLSearchParams(query))).toEqual({
      success: false,
      invalidParam,
    });
  });

  it("round-trips a discovery query through serialize and parse", () => {
    const query = {
      limit: 25,
      offset: 25,
      status: "archived" as const,
      excludeAutomationLineage: false,
      createdBy: ["a".repeat(32)],
      q: "owner/repo",
      repoOwner: "group/subgroup",
      repoName: "service",
      environmentId: "env-2",
      origin: "user" as const,
    };
    const parsed = parseSessionListQuery(serializeSessionListQuery(query));
    expect(parsed).toEqual({ success: true, data: { ...query, excludeStatus: undefined } });
  });
});
