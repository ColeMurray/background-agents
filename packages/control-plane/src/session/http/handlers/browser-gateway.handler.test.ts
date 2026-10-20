import { describe, expect, it, vi } from "vitest";
import { BrowserGateway, hostMatches, type BrowserGatewayBridge } from "./browser-gateway.handler";

function harness(
  options: {
    sessionCapability?: "off" | "read_only" | "enabled";
    liveMode?: "off" | "read_only" | "enabled";
    allowedDomains?: string[];
    actorId?: string | null;
    belongsToSession?: boolean;
  } = {}
) {
  const recordActivity = vi.fn();
  const bridge: BrowserGatewayBridge = {
    liveMode: () => options.liveMode ?? "enabled",
    sessionCapability: () => options.sessionCapability ?? "enabled",
    allowedDomains: () => options.allowedDomains ?? ["example.com", "*.docs.example.com"],
    operationActor: () => (options.actorId === undefined ? "user-1" : options.actorId),
    operationBelongsToSession: () => options.belongsToSession ?? true,
    recordActivity,
  };
  const gateway = new BrowserGateway({ browser: bridge, getSessionId: () => "session-1" });
  return { gateway, recordActivity };
}

describe("BrowserGateway", () => {
  it("authorizes a page inside the reviewed hosts", () => {
    const h = harness();

    expect(h.gateway.authorize({ url: "https://example.com/docs" }, "message-1")).toEqual({
      kind: "allowed",
      actorId: "user-1",
    });
  });

  it("refuses an action that needs a human approval, by name", () => {
    const h = harness();

    for (const action of ["login", "upload", "download"]) {
      const decision = h.gateway.authorize(
        { action, url: "https://example.com/page" },
        "operation-1"
      );
      expect(decision).toMatchObject({
        kind: "denied",
        code: "browser_action_needs_approval",
      });
    }
  });

  it("refuses an action the browser does not offer", () => {
    const h = harness();

    const decision = h.gateway.authorize(
      { action: "evaluate", url: "https://example.com/page" },
      "operation-1"
    );

    expect(decision).toMatchObject({ kind: "denied", code: "browser_action_not_allowed" });
  });

  it("authorizes a read and a screenshot", () => {
    const h = harness();

    for (const action of ["read", "screenshot"]) {
      const decision = h.gateway.authorize(
        { action, url: "https://example.com/page" },
        "operation-1"
      );
      expect(decision).toMatchObject({ kind: "allowed" });
    }
  });

  it("refuses a page outside the reviewed hosts", () => {
    const h = harness();

    expect(h.gateway.authorize({ url: "https://evil.example.net/" }, "message-1")).toMatchObject({
      kind: "denied",
      code: "browser_domain_not_allowed",
    });
  });

  it("refuses every page when the deployment reviewed no host", () => {
    const h = harness({ allowedDomains: [] });

    expect(h.gateway.authorize({ url: "https://example.com/" }, "message-1")).toMatchObject({
      code: "browser_domain_not_allowed",
    });
  });

  it("refuses a page when the session capability is off", () => {
    const h = harness({ sessionCapability: "off" });

    expect(h.gateway.authorize({ url: "https://example.com/" }, "message-1")).toMatchObject({
      code: "browser_disabled",
    });
  });

  it("refuses a page when the live deployment mode denies it", () => {
    const h = harness({ liveMode: "read_only" });

    expect(h.gateway.authorize({ url: "https://example.com/" }, "message-1")).toMatchObject({
      code: "browser_disabled",
    });
  });

  it("refuses a request whose turn belongs to another session", () => {
    const h = harness({ belongsToSession: false });

    expect(h.gateway.authorize({ url: "https://example.com/" }, "message-1")).toMatchObject({
      code: "browser_turn_not_in_session",
    });
  });

  it("refuses a request with no workspace actor", () => {
    const h = harness({ actorId: null });

    expect(h.gateway.authorize({ url: "https://example.com/" }, "message-1")).toMatchObject({
      code: "browser_actor_missing",
    });
  });

  it("refuses a scheme that is not a page", () => {
    const h = harness();

    expect(h.gateway.authorize({ url: "file:///etc/passwd" }, "message-1")).toMatchObject({
      code: "browser_scheme_not_allowed",
    });
  });

  it("records the decision so collaborators can see the browser activity", () => {
    const h = harness();

    h.gateway.record(
      { url: "https://example.com/docs" },
      "message-1",
      h.gateway.authorize({ url: "https://example.com/docs" }, "message-1")
    );

    expect(h.recordActivity).toHaveBeenCalledWith({
      operationId: "message-1",
      actorId: "user-1",
      url: "https://example.com/docs",
      outcome: "authorized",
      reason: null,
    });
  });

  it("matches a wildcard only for its sub-domains", () => {
    expect(hostMatches("docs.example.com", ["*.example.com"])).toBe(true);
    expect(hostMatches("example.com", ["*.example.com"])).toBe(false);
    expect(hostMatches("example.com", ["example.com"])).toBe(true);
    expect(hostMatches("notexample.com", ["example.com"])).toBe(false);
  });
});
