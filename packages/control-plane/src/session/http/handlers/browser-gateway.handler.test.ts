import { describe, expect, it, vi } from "vitest";
import { BrowserGateway, hostMatches, type BrowserGatewayBridge } from "./browser-gateway.handler";
import type { PiBrowserOutcome } from "../../../pi/browser-transport";

function harness(
  options: {
    sessionCapability?: "off" | "read_only" | "enabled";
    liveMode?: "off" | "read_only" | "enabled";
    allowedDomains?: string[];
    actorId?: string | null;
    belongsToSession?: boolean;
    browserAvailable?: boolean;
    authorMayAct?: boolean;
    readFails?: boolean;
  } = {}
) {
  const recordActivity = vi.fn();
  const read = vi.fn(async (): Promise<PiBrowserOutcome> => {
    if (options.readFails) throw new Error("browser-rendering internal detail");
    return { action: "read", url: "https://example.com/docs", text: "the page", truncated: false };
  });
  const bridge: BrowserGatewayBridge = {
    liveMode: () => options.liveMode ?? "enabled",
    sessionCapability: () => options.sessionCapability ?? "enabled",
    allowedDomains: () => options.allowedDomains ?? ["example.com", "*.docs.example.com"],
    operationActor: () => (options.actorId === undefined ? "user-1" : options.actorId),
    operationBelongsToSession: () => options.belongsToSession ?? true,
    authorMayAct: async () => options.authorMayAct ?? true,
    browserAvailable: () => options.browserAvailable ?? true,
    read,
    recordActivity,
  };
  const gateway = new BrowserGateway({ browser: bridge, getSessionId: () => "session-1" });
  return { gateway, recordActivity, read };
}

describe("BrowserGateway", async () => {
  it("authorizes a page inside the reviewed hosts", async () => {
    const h = harness();

    expect(await h.gateway.authorize({ url: "https://example.com/docs" }, "message-1")).toEqual({
      kind: "allowed",
      actorId: "user-1",
    });
  });

  it("refuses an action that needs a human approval, by name", async () => {
    const h = harness();

    for (const action of ["login", "upload", "download"]) {
      const decision = await h.gateway.authorize(
        { action, url: "https://example.com/page" },
        "operation-1"
      );
      expect(decision).toMatchObject({
        kind: "denied",
        code: "browser_action_needs_approval",
      });
    }
  });

  it("refuses an action the browser does not offer", async () => {
    const h = harness();

    const decision = await h.gateway.authorize(
      { action: "evaluate", url: "https://example.com/page" },
      "operation-1"
    );

    expect(decision).toMatchObject({ kind: "denied", code: "browser_action_not_allowed" });
  });

  it("authorizes a read and a screenshot", async () => {
    const h = harness();

    for (const action of ["read", "screenshot"]) {
      const decision = await h.gateway.authorize(
        { action, url: "https://example.com/page" },
        "operation-1"
      );
      expect(decision).toMatchObject({ kind: "allowed" });
    }
  });

  it("refuses a page outside the reviewed hosts", async () => {
    const h = harness();

    expect(
      await h.gateway.authorize({ url: "https://evil.example.net/" }, "message-1")
    ).toMatchObject({
      kind: "denied",
      code: "browser_domain_not_allowed",
    });
  });

  it("refuses every page when the deployment reviewed no host", async () => {
    const h = harness({ allowedDomains: [] });

    expect(await h.gateway.authorize({ url: "https://example.com/" }, "message-1")).toMatchObject({
      code: "browser_domain_not_allowed",
    });
  });

  it("refuses a page when the session capability is off", async () => {
    const h = harness({ sessionCapability: "off" });

    expect(await h.gateway.authorize({ url: "https://example.com/" }, "message-1")).toMatchObject({
      code: "browser_disabled",
    });
  });

  it("refuses a page when the live deployment mode denies it", async () => {
    const h = harness({ liveMode: "off" });

    expect(await h.gateway.authorize({ url: "https://example.com/" }, "message-1")).toMatchObject({
      code: "browser_disabled",
    });
  });

  it("refuses a request whose turn belongs to another session", async () => {
    const h = harness({ belongsToSession: false });

    expect(await h.gateway.authorize({ url: "https://example.com/" }, "message-1")).toMatchObject({
      code: "browser_turn_not_in_session",
    });
  });

  it("refuses a request with no workspace actor", async () => {
    const h = harness({ actorId: null });

    expect(await h.gateway.authorize({ url: "https://example.com/" }, "message-1")).toMatchObject({
      code: "browser_actor_missing",
    });
  });

  it("refuses a request after the turn author loses current authority", async () => {
    const h = harness({ authorMayAct: false });

    await expect(
      h.gateway.authorize({ action: "read", url: "https://example.com/" }, "message-1")
    ).resolves.toMatchObject({
      kind: "denied",
      code: "browser_author_no_longer_allowed",
    });
  });

  it("refuses a scheme that is not a page", async () => {
    const h = harness();

    expect(await h.gateway.authorize({ url: "file:///etc/passwd" }, "message-1")).toMatchObject({
      code: "browser_scheme_not_allowed",
    });
  });

  it("records the decision so collaborators can see the browser activity", async () => {
    const h = harness();

    h.gateway.record(
      { action: "read", url: "https://example.com/docs" },
      "message-1",
      await h.gateway.authorize({ action: "read", url: "https://example.com/docs" }, "message-1")
    );

    expect(h.recordActivity).toHaveBeenCalledWith({
      operationId: "message-1",
      actorId: "user-1",
      url: "https://example.com/docs",
      outcome: "authorized",
      reason: null,
    });
  });

  it("does not record the early gate, which is a policy fact and not activity", async () => {
    const h = harness();

    h.gateway.record(
      { url: "https://example.com/docs" },
      "message-1",
      await h.gateway.authorize({ url: "https://example.com/docs" }, "message-1")
    );

    expect(h.recordActivity).not.toHaveBeenCalled();
  });

  it("matches a wildcard only for its sub-domains", async () => {
    expect(hostMatches("docs.example.com", ["*.example.com"])).toBe(true);
    expect(hostMatches("example.com", ["*.example.com"])).toBe(false);
    expect(hostMatches("example.com", ["example.com"])).toBe(true);
    expect(hostMatches("notexample.com", ["example.com"])).toBe(false);
  });
});

describe("the browser read route", async () => {
  function readRequest(body: unknown, operationId = "operation-1"): Request {
    return new Request("http://session/internal/pi-browser/read", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pi-Operation-ID": operationId,
      },
      body: JSON.stringify(body),
    });
  }

  it("authorizes, records, and carries out the request", async () => {
    const h = harness();

    const response = await h.gateway.readRequest(
      readRequest({ action: "read", url: "https://example.com/docs" })
    );
    const body = await response.json();

    expect(body).toMatchObject({
      allowed: true,
      outcome: { action: "read", url: "https://example.com/docs", text: "the page" },
    });
    expect(h.read).toHaveBeenCalledWith({ action: "read", url: "https://example.com/docs" });
    expect(h.recordActivity).toHaveBeenCalledWith({
      operationId: "operation-1",
      actorId: "user-1",
      url: "https://example.com/docs",
      outcome: "authorized",
      reason: null,
    });
  });

  it("never drives the browser for a page outside the reviewed hosts", async () => {
    const h = harness();

    const response = await h.gateway.readRequest(
      readRequest({ action: "read", url: "https://evil.example.net/" })
    );

    expect(await response.json()).toMatchObject({
      allowed: false,
      code: "browser_domain_not_allowed",
    });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "refused" }) as never
    );
  });

  it("refuses a sensitive action by name and never drives the browser", async () => {
    const h = harness();

    const response = await h.gateway.readRequest(
      readRequest({ action: "login", url: "https://example.com/docs" })
    );

    expect(await response.json()).toMatchObject({
      allowed: false,
      code: "browser_action_needs_approval",
    });
    expect(h.read).not.toHaveBeenCalled();
  });

  it("refuses a request whose turn belongs to another session", async () => {
    const h = harness({ belongsToSession: false });

    const response = await h.gateway.readRequest(
      readRequest({ action: "read", url: "https://example.com/docs" })
    );

    expect(await response.json()).toMatchObject({
      allowed: false,
      code: "browser_turn_not_in_session",
    });
    expect(h.read).not.toHaveBeenCalled();
  });

  it("refuses a request with no workspace actor", async () => {
    const h = harness({ actorId: null });

    const response = await h.gateway.readRequest(
      readRequest({ action: "read", url: "https://example.com/docs" })
    );

    expect(await response.json()).toMatchObject({
      allowed: false,
      code: "browser_actor_missing",
    });
    expect(h.read).not.toHaveBeenCalled();
  });

  it("refuses a request that names no work", async () => {
    const h = harness();

    const response = await h.gateway.readRequest(readRequest({ url: "https://example.com/docs" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      allowed: false,
      code: "browser_request_invalid",
    });
    expect(h.read).not.toHaveBeenCalled();
  });

  it("refuses when the deployment stages no browser", async () => {
    const h = harness({ browserAvailable: false });

    const response = await h.gateway.readRequest(
      readRequest({ action: "read", url: "https://example.com/docs" })
    );

    expect(await response.json()).toMatchObject({ allowed: false, code: "browser_unavailable" });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "refused" }) as never
    );
  });

  it("keeps the platform's own failure inside the platform", async () => {
    const h = harness({ readFails: true });

    const response = await h.gateway.readRequest(
      readRequest({ action: "read", url: "https://example.com/docs" })
    );
    const body = await response.json();

    expect(body).toMatchObject({ allowed: false, reason: "The page could not be loaded" });
    expect(JSON.stringify(body)).not.toContain("browser-rendering internal detail");
  });
});
