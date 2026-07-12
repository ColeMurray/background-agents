import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import {
  CONTROL_PLANE_REQUEST_TIMEOUT_MS,
  createSession,
  sendPrompt,
} from "./control-plane-client";

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
    expect(timeoutSpy).toHaveBeenCalledWith(CONTROL_PLANE_REQUEST_TIMEOUT_MS);
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
    const result = sendPrompt(makeEnv(fetch), "session-1", "Fix it", "slack:U123");

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(result).resolves.toBeNull();
    expect(timeoutSpy).toHaveBeenCalledWith(CONTROL_PLANE_REQUEST_TIMEOUT_MS);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
