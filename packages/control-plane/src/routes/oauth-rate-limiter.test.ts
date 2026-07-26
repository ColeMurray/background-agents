import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { CloudflareOAuthRateLimiter } from "./oauth-rate-limiter";

describe("CloudflareOAuthRateLimiter", () => {
  it("rejects an exhausted bucket without placing the source address in the key", async () => {
    const limit = vi.fn(async (_options: { key: string }) => ({ success: false }));
    const hashSource = vi.fn(async () => "source-hash");
    const limiter = new CloudflareOAuthRateLimiter({ emit: vi.fn() }, { hashSource });
    const request = new Request("https://cp.example.com/oauth/authorize", {
      headers: { "CF-Connecting-IP": "203.0.113.4" },
    });

    await expect(
      limiter.requireAllowance({
        request,
        env: {
          AUTH_RATE_LIMITER: { limit },
          AUTH_RATE_LIMIT_WINDOW_SECONDS: "10",
        } as unknown as Env,
        routeClass: "authorize",
        clientId: "web",
        requestId: "request-1",
        traceId: "trace-1",
      })
    ).rejects.toEqual(expect.objectContaining({ retryAfterSeconds: 10 }));
    expect(limit).toHaveBeenCalledWith({
      key: "authorize:web:source-hash",
    });
    expect(hashSource).toHaveBeenCalledWith("oauth-source:203.0.113.4");
    expect(limit.mock.calls[0]?.[0]?.key).not.toContain("203.0.113.4");
  });

  it("fails open and emits a credential-free event when the binding is unavailable", async () => {
    const events = { emit: vi.fn() };
    const hashSource = vi.fn();
    const limiter = new CloudflareOAuthRateLimiter(events, { hashSource });

    await expect(
      limiter.requireAllowance({
        request: new Request("https://cp.example.com/oauth/authorize", {
          headers: { "CF-Connecting-IP": "203.0.113.4" },
        }),
        env: {} as Env,
        routeClass: "authorize",
        clientId: "web",
        requestId: "request-1",
        traceId: "trace-1",
      })
    ).resolves.toBeUndefined();
    expect(hashSource).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      "auth.oauth.rate_limiter_unavailable",
      {
        route_class: "authorize",
        failure: "binding_missing",
        request_id: "request-1",
        trace_id: "trace-1",
      },
      "warn"
    );
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain("203.0.113.4");
  });

  it("fails open when the edge source address is unavailable", async () => {
    const events = { emit: vi.fn() };
    const hashSource = vi.fn();
    const limit = vi.fn();
    const limiter = new CloudflareOAuthRateLimiter(events, { hashSource });

    await expect(
      limiter.requireAllowance({
        request: new Request("https://cp.example.com/oauth/authorize"),
        env: {
          AUTH_RATE_LIMITER: { limit },
          AUTH_RATE_LIMIT_WINDOW_SECONDS: "60",
        } as unknown as Env,
        routeClass: "authorize",
        clientId: "web",
        requestId: "request-1",
        traceId: "trace-1",
      })
    ).resolves.toBeUndefined();
    expect(hashSource).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      "auth.oauth.rate_limiter_unavailable",
      {
        route_class: "authorize",
        failure: "source_missing",
        request_id: "request-1",
        trace_id: "trace-1",
      },
      "warn"
    );
  });

  it("fails open when the deployed rate-limit window is unavailable", async () => {
    const events = { emit: vi.fn() };
    const hashSource = vi.fn();
    const limit = vi.fn();
    const limiter = new CloudflareOAuthRateLimiter(events, { hashSource });

    await expect(
      limiter.requireAllowance({
        request: new Request("https://cp.example.com/oauth/authorize", {
          headers: { "CF-Connecting-IP": "203.0.113.4" },
        }),
        env: { AUTH_RATE_LIMITER: { limit } } as unknown as Env,
        routeClass: "authorize",
        clientId: "web",
        requestId: "request-1",
        traceId: "trace-1",
      })
    ).resolves.toBeUndefined();
    expect(hashSource).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      "auth.oauth.rate_limiter_unavailable",
      {
        route_class: "authorize",
        failure: "window_configuration_invalid",
        request_id: "request-1",
        trace_id: "trace-1",
      },
      "warn"
    );
  });

  it("fails open without exposing the source when the binding throws", async () => {
    const events = { emit: vi.fn() };
    const limiter = new CloudflareOAuthRateLimiter(events, {
      hashSource: vi.fn(async () => "source-hash"),
    });

    await expect(
      limiter.requireAllowance({
        request: new Request("https://cp.example.com/oauth/token", {
          headers: { "CF-Connecting-IP": "203.0.113.5" },
        }),
        env: {
          AUTH_RATE_LIMIT_WINDOW_SECONDS: "60",
          AUTH_RATE_LIMITER: {
            limit: vi.fn(async () => {
              throw new Error("platform unavailable");
            }),
          },
        } as unknown as Env,
        routeClass: "token",
        clientId: "web",
        requestId: "request-2",
        traceId: "trace-2",
      })
    ).resolves.toBeUndefined();
    expect(events.emit).toHaveBeenCalledWith(
      "auth.oauth.rate_limiter_unavailable",
      {
        route_class: "token",
        failure: "Error",
        request_id: "request-2",
        trace_id: "trace-2",
      },
      "warn"
    );
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain("203.0.113.5");
  });
});
