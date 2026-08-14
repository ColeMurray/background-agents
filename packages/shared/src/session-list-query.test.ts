import { describe, expect, it } from "vitest";
import {
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
