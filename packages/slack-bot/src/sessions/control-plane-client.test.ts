import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { createSession, sendPrompt } from "./control-plane-client";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "../request-options";

function makeEnv(fetch: ReturnType<typeof vi.fn>): Env {
  return {
    CONTROL_PLANE: { fetch } as unknown as Fetcher,
    INTERNAL_CALLBACK_SECRET: "test-secret",
    LOG_LEVEL: "error",
  } as Env;
}

const target = {
  kind: "repository" as const,
  repo: {
    id: "acme/app",
    owner: "acme",
    name: "app",
    fullName: "acme/app",
    displayName: "acme/app",
    description: "Application repository",
    defaultBranch: "main",
    private: true,
  },
};

describe("control plane client timeouts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts session creation after the control plane timeout", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    const result = createSession(makeEnv(fetch), {
      target,
      model: "openai/gpt-5.4",
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(result).resolves.toBeNull();
    expect(timeoutSpy).toHaveBeenCalledWith(OUTBOUND_REQUEST_TIMEOUT_MS);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("aborts prompt delivery after the control plane timeout", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    const result = sendPrompt(makeEnv(fetch), {
      sessionId: "session-1",
      content: "Fix it",
      authorId: "slack:U123",
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(result).resolves.toEqual({ ok: false, reason: "transient" });
    expect(timeoutSpy).toHaveBeenCalledWith(OUTBOUND_REQUEST_TIMEOUT_MS);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("classifies only not-found prompt responses as stale", async () => {
    const notFoundFetch = vi.fn(async () => new Response(null, { status: 404 }));
    const serverErrorFetch = vi.fn(async () => new Response(null, { status: 503 }));

    await expect(
      sendPrompt(makeEnv(notFoundFetch), {
        sessionId: "missing-session",
        content: "Fix it",
        authorId: "slack:U123",
      })
    ).resolves.toEqual({ ok: false, reason: "stale" });
    await expect(
      sendPrompt(makeEnv(serverErrorFetch), {
        sessionId: "session-1",
        content: "Fix it",
        authorId: "slack:U123",
      })
    ).resolves.toEqual({ ok: false, reason: "transient" });
  });
});
