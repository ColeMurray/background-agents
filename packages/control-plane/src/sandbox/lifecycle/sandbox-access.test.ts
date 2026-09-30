import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSandboxAccess,
  TERMINAL_TOKEN_TTL_SECONDS,
  type SandboxAccess,
  type SandboxAccessDependencies,
  type SandboxAccessStorage,
} from "./sandbox-access";

const URL = "https://access.test";
const SECRET = "private-sandbox-secret";
const CHANGED = { type: "sandbox_access_changed" } as const;

function fixture(overrides: Partial<SandboxAccessDependencies> = {}) {
  const calls: string[] = [];
  const storage = {
    updateSandboxAccess: vi.fn<SandboxAccessStorage["updateSandboxAccess"]>(),
    clearSandboxAccess: vi.fn<SandboxAccessStorage["clearSandboxAccess"]>((kind) => {
      calls.push(`clear:${kind}`);
    }),
    clearSandboxAccessUrl: vi.fn<NonNullable<SandboxAccessStorage["clearSandboxAccessUrl"]>>(
      (kind) => {
        calls.push(`clearUrl:${kind}`);
      }
    ),
    updateSandboxTunnelUrls: vi.fn<SandboxAccessStorage["updateSandboxTunnelUrls"]>(),
    clearSandboxTunnelUrls: vi.fn(() => {
      calls.push("clearTunnels");
    }),
  };
  const broadcaster = {
    broadcast: vi.fn<SandboxAccessDependencies["broadcaster"]["broadcast"]>(() => {
      calls.push("broadcast");
    }),
  };
  const sockets = {
    getSandboxWebSocket: vi.fn<SandboxAccessDependencies["sockets"]["getSandboxWebSocket"]>(
      () => null
    ),
    detachSandboxWebSocket: vi.fn(() => {
      calls.push("detach");
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const getLogger = vi.fn(() => logger);
  const canResumeAfterStop = vi.fn(() => false);
  const sandboxDashboardUrlBuilder = vi.fn<
    NonNullable<SandboxAccessDependencies["sandboxDashboardUrlBuilder"]>
  >(() => null);
  const dependencies: SandboxAccessDependencies = {
    storage,
    broadcaster,
    sockets,
    canResumeAfterStop,
    getLogger,
    sandboxDashboardUrlBuilder,
    ...overrides,
  };
  return {
    access: createSandboxAccess(dependencies),
    dependencies,
    storage,
    broadcaster,
    sockets,
    logger,
    getLogger,
    canResumeAfterStop,
    sandboxDashboardUrlBuilder,
    calls,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("createSandboxAccess", () => {
  it("does no dependency work at construction, even without an initialized logger", () => {
    const getLogger = vi.fn(() => {
      throw new Error("session not initialized");
    });
    const f = fixture({ getLogger });

    for (const dependency of [
      ...Object.values(f.storage),
      ...Object.values(f.broadcaster),
      ...Object.values(f.sockets),
      ...Object.values(f.logger),
      getLogger,
      f.canResumeAfterStop,
      f.sandboxDashboardUrlBuilder,
    ]) {
      expect(dependency).not.toHaveBeenCalled();
    }
  });

  it.each([
    { resumable: false, urlSupport: true, clear: "clear" },
    { resumable: true, urlSupport: true, clear: "clearUrl" },
    { resumable: true, urlSupport: false, clear: "clear" },
  ])(
    "clears all access and tunnels before notifying and detaching (resumable=$resumable, urlSupport=$urlSupport)",
    ({ resumable, urlSupport, clear }) => {
      const f = fixture();
      f.canResumeAfterStop.mockReturnValue(resumable);
      if (!urlSupport) delete f.dependencies.storage.clearSandboxAccessUrl;
      const cleared = [
        `${clear}:codeServer`,
        `${clear}:vnc`,
        `${clear}:ttyd`,
        "clearTunnels",
        "broadcast",
      ];

      f.access.clearAccess();
      expect(f.calls).toEqual(cleared);
      expect(f.sockets.detachSandboxWebSocket).not.toHaveBeenCalled();

      f.access.retireShutdownAccess();
      expect(f.calls).toEqual([...cleared, ...cleared, "detach"]);
      expect(f.broadcaster.broadcast.mock.calls).toEqual([[CHANGED], [CHANGED]]);
      expect(f.sockets.detachSandboxWebSocket).toHaveBeenCalledExactlyOnceWith(
        1000,
        "Sandbox state preserved"
      );
      expect(f.canResumeAfterStop).toHaveBeenCalledTimes(2);
      expect(f.getLogger).not.toHaveBeenCalled();
    }
  );

  it.each(["credentials", "urls", "tunnels", "broadcast"] as const)(
    "propagates a %s retirement failure without detaching or catching it",
    (stage) => {
      const f = fixture();
      const error = new Error("retirement failed");
      f.canResumeAfterStop.mockReturnValue(stage === "urls");
      const failing = {
        credentials: f.storage.clearSandboxAccess,
        urls: f.storage.clearSandboxAccessUrl,
        tunnels: f.storage.clearSandboxTunnelUrls,
        broadcast: f.broadcaster.broadcast,
      }[stage];
      failing.mockImplementationOnce(() => {
        throw error;
      });

      expect(() => f.access.retireShutdownAccess()).toThrow(error);
      expect(f.sockets.detachSandboxWebSocket).not.toHaveBeenCalled();
      if (stage !== "broadcast") expect(f.broadcaster.broadcast).not.toHaveBeenCalled();
      expect(f.getLogger).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      kind: "codeServer",
      store: (access: SandboxAccess) => access.storeCodeServer(URL, SECRET),
      message: "Storing code-server info",
    },
    {
      kind: "vnc",
      store: (access: SandboxAccess) => access.storeVnc(URL, SECRET),
      message: "Storing VNC info",
    },
    {
      kind: "ttyd",
      store: (access: SandboxAccess) => access.storeTtyd(URL, SECRET, "session-1", "sandbox-1"),
      message: "Storing ttyd info",
    },
  ])(
    "awaits $kind persistence, propagates failures, and resolves the current logger without logging secrets",
    async ({ kind, store, message }) => {
      const f = fixture();
      let resolve!: () => void;
      f.storage.updateSandboxAccess.mockReturnValueOnce(
        new Promise<void>((done) => {
          resolve = done;
        })
      );
      const settled = vi.fn();
      const storing = store(f.access).then(settled);

      await vi.waitFor(() => expect(f.storage.updateSandboxAccess).toHaveBeenCalledOnce());
      expect(f.storage.updateSandboxAccess).toHaveBeenCalledWith(
        kind,
        URL,
        kind === "ttyd" ? expect.any(String) : SECRET
      );
      if (kind === "ttyd") {
        expect(f.storage.updateSandboxAccess.mock.calls[0][2]).not.toBe(SECRET);
      }
      expect(settled).not.toHaveBeenCalled();
      resolve();
      await storing;
      expect(settled).toHaveBeenCalledOnce();

      const nextLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      f.getLogger.mockReturnValue(nextLogger);
      const error = new Error("persistence failed");
      f.storage.updateSandboxAccess.mockRejectedValueOnce(error);
      await expect(store(f.access)).rejects.toBe(error);

      expect(f.logger.info.mock.calls).toEqual([[message, { url: URL }]]);
      expect(nextLogger.info.mock.calls).toEqual([[message, { url: URL }]]);
      expect(f.getLogger).toHaveBeenCalledTimes(2);
      expect(f.logger.warn).not.toHaveBeenCalled();
      expect(nextLogger.warn).not.toHaveBeenCalled();
      expect(f.broadcaster.broadcast).not.toHaveBeenCalled();
    }
  );

  it("mints only the terminal claims with the TTL and an HS256 signature, without dependency work", async () => {
    const f = fixture();
    const nowMs = 1_700_000_000_999;
    vi.spyOn(Date, "now").mockReturnValue(nowMs);

    const token = await f.access.mintTtydToken(SECRET, "session-1", "sandbox-1");
    const [header, body, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(body, "base64url").toString())).toEqual({
      sub: "session-1",
      sid: "sandbox-1",
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor(nowMs / 1000) + TERMINAL_TOKEN_TTL_SECONDS,
    });
    expect(signature).toBe(
      createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url")
    );
    expect(f.storage.updateSandboxAccess).not.toHaveBeenCalled();
    expect(f.broadcaster.broadcast).not.toHaveBeenCalled();
    expect(f.getLogger).not.toHaveBeenCalled();
  });

  it("reuses an unexpired token and warns only for advertised access with a missing or expired token", async () => {
    const f = fixture();
    const nowMs = 1_700_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const token = await f.access.mintTtydToken(SECRET, "session-1", "sandbox-1");

    expect(f.access.reusableTtydToken(token, URL, "provider-1")).toBe(token);
    expect(f.access.reusableTtydToken(token, undefined, "provider-1")).toBe(token);
    expect(f.access.reusableTtydToken(null, undefined, "provider-1")).toBeNull();
    clock.mockReturnValue(nowMs + TERMINAL_TOKEN_TTL_SECONDS * 1000);
    expect(f.access.reusableTtydToken(token, undefined, "provider-1")).toBeNull();
    expect(f.getLogger).not.toHaveBeenCalled();

    expect(f.access.reusableTtydToken(null, URL, "provider-1")).toBeNull();
    expect(f.access.reusableTtydToken(token, URL, "provider-1")).toBeNull();
    expect(f.logger.warn.mock.calls).toEqual(
      ["missing", "invalid_or_expired"].map((reason) => [
        "Terminal credential unavailable; resuming without terminal access",
        {
          event: "sandbox.resume_terminal_credential_unavailable",
          provider_object_id: "provider-1",
          reason,
        },
      ])
    );
    expect(f.storage.updateSandboxAccess).not.toHaveBeenCalled();
    expect(f.broadcaster.broadcast).not.toHaveBeenCalled();
  });

  it("skips absent or empty tunnels without storage, notification, or logger resolution", async () => {
    const f = fixture();

    await f.access.storeAndBroadcastTunnelUrls(undefined);
    await f.access.storeAndBroadcastTunnelUrls({});

    expect(f.storage.updateSandboxTunnelUrls).not.toHaveBeenCalled();
    expect(f.broadcaster.broadcast).not.toHaveBeenCalled();
    expect(f.getLogger).not.toHaveBeenCalled();
  });

  it("yields before each tunnel notification even for synchronous storage, and propagates rejection without notifying", async () => {
    const f = fixture();
    const urls = { "3000": "https://preview.test", "8080": "https://api.test" };

    for (let count = 0; count < 2; count++) {
      const storing = f.access.storeAndBroadcastTunnelUrls(urls);
      expect(f.storage.updateSandboxTunnelUrls).toHaveBeenCalledWith(urls);
      expect(f.broadcaster.broadcast).toHaveBeenCalledTimes(count);
      await storing;
      expect(f.broadcaster.broadcast).toHaveBeenCalledTimes(count + 1);
    }

    const error = new Error("tunnel persistence failed");
    f.storage.updateSandboxTunnelUrls.mockRejectedValueOnce(error);
    await expect(f.access.storeAndBroadcastTunnelUrls(urls)).rejects.toBe(error);
    expect(f.storage.updateSandboxTunnelUrls.mock.calls).toEqual([[urls], [urls], [urls]]);
    expect(f.broadcaster.broadcast.mock.calls).toEqual([[CHANGED], [CHANGED]]);
    expect(f.logger.info.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [
        "Storing and broadcasting tunnel URLs",
        { ports: ["3000", "8080"] },
      ])
    );
    expect(f.logger.warn).not.toHaveBeenCalled();
  });

  it("keeps dashboard and connected notifications distinct and repeatable, with no notification when unavailable", () => {
    const f = fixture();
    const withoutBuilder = createSandboxAccess({
      ...f.dependencies,
      sandboxDashboardUrlBuilder: undefined,
    });

    expect(withoutBuilder.broadcastSandboxDashboardUrl("provider-1")).toBe(false);
    expect(f.sandboxDashboardUrlBuilder).not.toHaveBeenCalled();
    expect(f.access.broadcastSandboxDashboardUrl("provider-1")).toBe(false);
    f.access.broadcastProviderAccessIfConnected();
    expect(f.broadcaster.broadcast).not.toHaveBeenCalled();
    expect(f.getLogger).not.toHaveBeenCalled();

    f.sandboxDashboardUrlBuilder.mockReturnValue("https://dashboard.test/provider-1");
    f.sockets.getSandboxWebSocket.mockReturnValue({
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    });
    for (let count = 0; count < 2; count++) {
      expect(f.access.broadcastSandboxDashboardUrl("provider-1")).toBe(true);
      f.access.broadcastProviderAccessIfConnected();
    }

    expect(f.broadcaster.broadcast.mock.calls).toEqual(Array.from({ length: 4 }, () => [CHANGED]));
    expect(f.sandboxDashboardUrlBuilder.mock.calls).toEqual([
      ["provider-1"],
      ["provider-1"],
      ["provider-1"],
    ]);
    expect(f.sockets.getSandboxWebSocket).toHaveBeenCalledTimes(3);
    expect(f.logger.debug.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        "Broadcasting sandbox dashboard URL",
        { provider_object_id: "provider-1" },
      ])
    );
    expect(f.getLogger).toHaveBeenCalledTimes(2);
  });
});
