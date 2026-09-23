// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAuthorizationCodeStatusResponse } from "@open-inspect/shared/types/provider-accounts";
import {
  cancelProviderAuthorizationCode,
  completeProviderAuthorizationCode,
  readProviderAuthorizationCodeStatus,
  startProviderAuthorizationCode,
} from "./use-provider-accounts";
import { useProviderAuthorizationCode } from "./use-provider-authorization-code";

vi.mock("./use-provider-accounts", () => ({
  cancelProviderAuthorizationCode: vi.fn(),
  completeProviderAuthorizationCode: vi.fn(),
  readProviderAuthorizationCodeStatus: vi.fn(),
  startProviderAuthorizationCode: vi.fn(),
}));

/** A request that settles only when its signal is aborted, the way a hung fetch does. */
function neverSettles<T>(): (...args: unknown[]) => Promise<T> {
  return (...args) =>
    new Promise((_, reject) => {
      const signal = args[args.length - 1] as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    });
}

const transactionId = "f".repeat(64);
const authorizationUrl = "https://claude.ai/oauth/authorize?state=abc";
const createTarget = { operation: "create" as const, displayName: "Claude account" };
const started = {
  transactionId,
  provider: "anthropic" as const,
  operation: "create" as const,
  authorizationUrl,
  expiresAt: 61_000,
  expiresInMs: 60_000,
};
const connected = {
  status: "connected" as const,
  account: {
    id: "a".repeat(32),
    provider: "anthropic" as const,
    displayName: "Claude account",
    externalAccountId: null,
    status: "active" as const,
    createdBy: null,
    updatedBy: null,
    lastVerifiedAt: null,
    lastUsedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  },
  reconnectedExisting: false,
  completedAt: 5_000,
};

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useProviderAuthorizationCode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.mocked(cancelProviderAuthorizationCode).mockResolvedValue(undefined);
    vi.mocked(startProviderAuthorizationCode).mockResolvedValue(started);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("starts a transaction and waits for the pasted code with a local countdown", async () => {
    const { result } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, vi.fn())
    );
    expect(result.current.status).toBe("starting");

    await flushEffects();

    expect(startProviderAuthorizationCode).toHaveBeenCalledWith("anthropic", createTarget);
    expect(result.current.status).toBe("awaiting_code");
    expect(result.current.authorization?.authorizationUrl).toBe(authorizationUrl);
    expect(result.current.remainingMs).toBe(60_000);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current.remainingMs).toBe(59_000);
    expect(completeProviderAuthorizationCode).not.toHaveBeenCalled();
  });

  it("completes with the trimmed code and reports the connected account", async () => {
    const onConnected = vi.fn();
    vi.mocked(completeProviderAuthorizationCode).mockResolvedValue(connected);
    const { result, unmount } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, onConnected)
    );
    await flushEffects();

    await act(() => result.current.complete("  code#state  "));

    expect(completeProviderAuthorizationCode).toHaveBeenCalledWith(
      "anthropic",
      transactionId,
      "code#state",
      expect.any(AbortSignal)
    );
    expect(result.current.status).toBe("connected");
    expect(onConnected).toHaveBeenCalledWith(connected);
    unmount();
    expect(cancelProviderAuthorizationCode).not.toHaveBeenCalled();
  });

  it("returns to awaiting_code when the pasted code is rejected", async () => {
    vi.mocked(completeProviderAuthorizationCode)
      .mockRejectedValueOnce(
        Object.assign(new Error("Invalid authorization code"), { status: 400 })
      )
      .mockResolvedValueOnce(connected);
    const { result } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, vi.fn())
    );
    await flushEffects();

    await act(() => result.current.complete("wrong"));
    expect(result.current.status).toBe("awaiting_code");
    expect(result.current.failure).toEqual({
      message: "Invalid authorization code",
      status: 400,
      retryable: false,
    });
    expect(startProviderAuthorizationCode).toHaveBeenCalledOnce();

    await act(() => result.current.complete("right"));
    expect(result.current.status).toBe("connected");
    expect(result.current.failure).toBeNull();
  });

  it("refuses an empty code without calling the control plane", async () => {
    const { result } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, vi.fn())
    );
    await flushEffects();

    await act(() => result.current.complete("   "));

    expect(completeProviderAuthorizationCode).not.toHaveBeenCalled();
    expect(result.current.status).toBe("awaiting_code");
    expect(result.current.failure?.message).toBe("Enter the authorization code first.");
  });

  it("fails and offers a fresh transaction when the current one is gone", async () => {
    vi.mocked(completeProviderAuthorizationCode).mockRejectedValue(
      Object.assign(new Error("Authorization transaction not found"), { status: 404 })
    );
    const { result } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, vi.fn())
    );
    await flushEffects();

    await act(() => result.current.complete("code"));
    expect(result.current.status).toBe("failed");
    expect(result.current.failure).toEqual({
      message: "Authorization transaction not found",
      status: 404,
      retryable: true,
    });

    act(() => result.current.retry());
    await flushEffects();
    expect(startProviderAuthorizationCode).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("awaiting_code");
    expect(result.current.failure).toBeNull();
  });

  it("surfaces terminal provider outcomes from completion", async () => {
    const denied: ProviderAuthorizationCodeStatusResponse = {
      status: "denied",
      error: "Access was denied",
      retryable: false,
    };
    vi.mocked(completeProviderAuthorizationCode).mockResolvedValue(denied);
    const { result, unmount } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, vi.fn())
    );
    await flushEffects();

    await act(() => result.current.complete("code"));

    expect(result.current.status).toBe("denied");
    expect(result.current.failure).toEqual({ message: "Access was denied", retryable: false });
    unmount();
    expect(cancelProviderAuthorizationCode).not.toHaveBeenCalled();
  });

  it("reconciles a completion another request owns instead of declaring it gone", async () => {
    vi.mocked(completeProviderAuthorizationCode).mockRejectedValue(
      Object.assign(new Error("This authorization is already being completed"), {
        status: 409,
        retryable: true,
      })
    );
    vi.mocked(readProviderAuthorizationCodeStatus)
      .mockResolvedValueOnce({ status: "pending", expiresAt: 61_000 })
      .mockResolvedValueOnce(connected);
    const onConnected = vi.fn();
    const { result } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, onConnected)
    );
    await flushEffects();

    let completion!: Promise<void>;
    await act(async () => {
      completion = result.current.complete("code");
    });
    expect(result.current.status).toBe("completing");
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await act(() => completion);

    expect(readProviderAuthorizationCodeStatus).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("connected");
    expect(onConnected).toHaveBeenCalledWith(connected);
    expect(startProviderAuthorizationCode).toHaveBeenCalledOnce();
  });

  it("returns to code entry when a reconciled completion is still pending after the window", async () => {
    vi.mocked(completeProviderAuthorizationCode).mockRejectedValue(
      new TypeError("Failed to fetch")
    );
    vi.mocked(readProviderAuthorizationCodeStatus).mockResolvedValue({
      status: "pending",
      expiresAt: 61_000,
    });
    const { result } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, vi.fn())
    );
    await flushEffects();

    let completion!: Promise<void>;
    await act(async () => {
      completion = result.current.complete("code");
    });
    await act(() => vi.advanceTimersByTimeAsync(46_000));
    await act(() => completion);

    expect(result.current.status).toBe("awaiting_code");
    expect(result.current.failure).toEqual({
      message: "The provider has not confirmed the code yet. Paste it again.",
      retryable: false,
    });
  });

  it("aborts a completion that never settles at the deadline and reconciles the outcome", async () => {
    vi.mocked(startProviderAuthorizationCode).mockResolvedValue({
      ...started,
      expiresAt: 3_000,
      expiresInMs: 2_000,
    });
    vi.mocked(completeProviderAuthorizationCode).mockImplementation(neverSettles());
    vi.mocked(readProviderAuthorizationCodeStatus).mockResolvedValue({
      status: "pending",
      expiresAt: 3_000,
    });
    const { result } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, vi.fn())
    );
    await flushEffects();

    let completion!: Promise<void>;
    await act(async () => {
      completion = result.current.complete("code");
    });
    const signal = vi.mocked(completeProviderAuthorizationCode).mock.calls[0][3] as AbortSignal;
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(signal.aborted).toBe(true);
    expect(result.current.status).toBe("completing");

    await act(() => vi.advanceTimersByTimeAsync(46_000));
    await act(() => completion);

    expect(readProviderAuthorizationCodeStatus).toHaveBeenCalled();
    expect(result.current.status).toBe("expired");
    expect(result.current.remainingMs).toBe(0);
  });

  it("aborts an in-flight completion on unmount", async () => {
    vi.mocked(completeProviderAuthorizationCode).mockImplementation(neverSettles());
    const { result, unmount } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, vi.fn())
    );
    await flushEffects();

    await act(async () => {
      void result.current.complete("code");
    });
    const signal = vi.mocked(completeProviderAuthorizationCode).mock.calls[0][3] as AbortSignal;
    unmount();

    expect(signal.aborted).toBe(true);
    expect(cancelProviderAuthorizationCode).toHaveBeenCalledWith("anthropic", transactionId);
  });

  it("expires when no code arrives before the deadline", async () => {
    vi.mocked(startProviderAuthorizationCode).mockResolvedValue({
      ...started,
      expiresAt: 3_000,
      expiresInMs: 2_000,
    });
    const { result } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, vi.fn())
    );
    await flushEffects();

    await act(() => vi.advanceTimersByTimeAsync(2_000));

    expect(result.current.status).toBe("expired");
    expect(result.current.remainingMs).toBe(0);
    expect(result.current.failure).toEqual({
      message: "Provider authorization expired.",
      retryable: true,
    });
    await act(() => result.current.complete("late"));
    expect(completeProviderAuthorizationCode).not.toHaveBeenCalled();
  });

  it("lets an in-flight completion settle before applying the deadline", async () => {
    vi.mocked(startProviderAuthorizationCode).mockResolvedValue({
      ...started,
      expiresAt: 3_000,
      expiresInMs: 2_000,
    });
    let resolveCompletion!: (value: ProviderAuthorizationCodeStatusResponse) => void;
    vi.mocked(completeProviderAuthorizationCode).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCompletion = resolve;
        })
    );
    const onConnected = vi.fn();
    const { result } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, onConnected)
    );
    await flushEffects();

    let completion!: Promise<void>;
    await act(async () => {
      completion = result.current.complete("code");
    });
    expect(result.current.status).toBe("completing");
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(result.current.status).toBe("completing");

    await act(async () => {
      resolveCompletion(connected);
      await completion;
    });

    expect(result.current.status).toBe("connected");
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it("keeps its initial target immutable across rerenders", async () => {
    const { rerender } = renderHook(
      ({ target }) => useProviderAuthorizationCode("anthropic", target, vi.fn()),
      { initialProps: { target: createTarget } }
    );
    await flushEffects();

    rerender({ target: { operation: "create" as const, displayName: "Changed account" } });

    expect(startProviderAuthorizationCode).toHaveBeenCalledOnce();
    expect(startProviderAuthorizationCode).toHaveBeenCalledWith("anthropic", createTarget);
  });

  it("best-effort cancels an unfinished transaction on cleanup", async () => {
    const { unmount } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, vi.fn())
    );
    await flushEffects();

    unmount();

    expect(cancelProviderAuthorizationCode).toHaveBeenCalledWith("anthropic", transactionId);
  });

  it("preserves permanent start failure metadata", async () => {
    vi.mocked(startProviderAuthorizationCode).mockRejectedValue(
      Object.assign(new Error("Provider account is archived"), {
        status: 409,
        retryable: false,
      })
    );
    const { result } = renderHook(() =>
      useProviderAuthorizationCode("anthropic", createTarget, vi.fn())
    );
    await flushEffects();

    expect(result.current.status).toBe("failed");
    expect(result.current.failure).toEqual({
      message: "Provider account is archived",
      status: 409,
      retryable: false,
    });
  });
});
