// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelProviderDeviceAuthorization,
  pollProviderDeviceAuthorization,
  startProviderDeviceAuthorization,
} from "./use-provider-accounts";
import { useProviderDeviceAuthorization } from "./use-provider-device-authorization";

vi.mock("./use-provider-accounts", () => ({
  cancelProviderDeviceAuthorization: vi.fn(),
  pollProviderDeviceAuthorization: vi.fn(),
  startProviderDeviceAuthorization: vi.fn(),
}));

const transactionId = "b".repeat(64);
const createTarget = { operation: "create" as const, displayName: "SuperGrok account" };

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useProviderDeviceAuthorization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.mocked(cancelProviderDeviceAuthorization).mockResolvedValue(undefined);
    vi.mocked(startProviderDeviceAuthorization).mockResolvedValue({
      transactionId,
      provider: "xai",
      operation: "create",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://example.com/device",
      expiresAt: 61_000,
      expiresInMs: 60_000,
      pollIntervalMs: 1_000,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("uses relative poll intervals despite server and browser clock skew", async () => {
    const onConnected = vi.fn();
    vi.mocked(pollProviderDeviceAuthorization)
      .mockResolvedValueOnce({
        status: "pending",
        expiresAt: 61_000,
        pollIntervalMs: 10_000,
        nextPollAt: 5_000,
      })
      .mockResolvedValueOnce({
        status: "connected",
        account: {
          id: "a".repeat(32),
          provider: "xai",
          displayName: "SuperGrok account",
          externalAccountId: "account-1",
          status: "active",
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
      });

    const { result, unmount } = renderHook(() =>
      useProviderDeviceAuthorization("xai", createTarget, onConnected)
    );
    await flushEffects();
    expect(result.current.status).toBe("pending");

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(pollProviderDeviceAuthorization).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(9_999));
    expect(pollProviderDeviceAuthorization).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));

    expect(onConnected).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("connected");
    unmount();
    expect(cancelProviderDeviceAuthorization).not.toHaveBeenCalled();
  });

  it("uses the response lifetime for a local countdown deadline", async () => {
    vi.mocked(pollProviderDeviceAuthorization).mockImplementation(
      () => new Promise(() => undefined)
    );
    const { result } = renderHook(() =>
      useProviderDeviceAuthorization("xai", createTarget, vi.fn())
    );
    await flushEffects();

    expect(result.current.remainingMs).toBe(60_000);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current.remainingMs).toBe(59_000);
  });

  it("keeps its initial target immutable across rerenders", async () => {
    vi.mocked(pollProviderDeviceAuthorization).mockImplementation(
      () => new Promise(() => undefined)
    );
    const { rerender } = renderHook(
      ({ target }) => useProviderDeviceAuthorization("xai", target, vi.fn()),
      { initialProps: { target: createTarget } }
    );
    await flushEffects();
    expect(startProviderDeviceAuthorization).toHaveBeenCalledOnce();

    rerender({
      target: { operation: "create" as const, displayName: "Changed account" },
    });

    expect(startProviderDeviceAuthorization).toHaveBeenCalledOnce();
    expect(startProviderDeviceAuthorization).toHaveBeenCalledWith("xai", createTarget);
  });

  it("best-effort cancels an unfinished transaction on cleanup", async () => {
    vi.mocked(pollProviderDeviceAuthorization).mockImplementation(
      () => new Promise(() => undefined)
    );
    const { unmount } = renderHook(() =>
      useProviderDeviceAuthorization("xai", createTarget, vi.fn())
    );
    await flushEffects();
    expect(startProviderDeviceAuthorization).toHaveBeenCalledOnce();

    unmount();

    expect(cancelProviderDeviceAuthorization).toHaveBeenCalledWith("xai", transactionId);
  });

  it("retries from a fresh transaction after a start failure", async () => {
    vi.mocked(startProviderDeviceAuthorization)
      .mockRejectedValueOnce(new Error("Temporarily unavailable"))
      .mockResolvedValueOnce({
        transactionId,
        provider: "xai",
        operation: "create",
        userCode: "FRESH-CODE",
        verificationUrl: "https://example.com/device",
        expiresAt: 61_000,
        expiresInMs: 60_000,
        pollIntervalMs: 1_000,
      });
    const { result } = renderHook(() =>
      useProviderDeviceAuthorization("xai", createTarget, vi.fn())
    );
    await flushEffects();
    expect(result.current.failure?.message).toBe("Temporarily unavailable");

    act(() => result.current.retry());

    await flushEffects();
    expect(result.current.authorization?.userCode).toBe("FRESH-CODE");
    expect(startProviderDeviceAuthorization).toHaveBeenCalledTimes(2);
  });

  it("preserves permanent API failure metadata", async () => {
    vi.mocked(startProviderDeviceAuthorization).mockRejectedValue(
      Object.assign(new Error("Provider account is archived"), {
        status: 409,
        retryable: false,
      })
    );
    const { result } = renderHook(() =>
      useProviderDeviceAuthorization("xai", createTarget, vi.fn())
    );
    await flushEffects();

    expect(result.current.failure).toEqual({
      message: "Provider account is archived",
      status: 409,
      retryable: false,
    });
  });
});
