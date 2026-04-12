// @vitest-environment jsdom

import type { PropsWithChildren, ReactElement } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { useMediaArtifactUrl } from "./use-media-artifact-url";

function createWrapper(): ({ children }: PropsWithChildren) => ReactElement {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
        }}
      >
        {children}
      </SWRConfig>
    );
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useMediaArtifactUrl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-11T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("refreshes the presigned URL before it expires", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          url: "https://media.example.com/first",
          expiresAt: Math.floor(Date.now() / 1000) + 61,
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          url: "https://media.example.com/second",
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useMediaArtifactUrl("session-1", "artifact-1"), {
      wrapper: createWrapper(),
    });

    await flushMicrotasks();

    expect(result.current.url).toBe("https://media.example.com/first");

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBe("https://media.example.com/second");
  });

  it("does not fetch when no artifactId is provided", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useMediaArtifactUrl("session-1", null), {
      wrapper: createWrapper(),
    });

    await flushMicrotasks();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.url).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("surfaces fetch errors from the media URL endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "boom" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useMediaArtifactUrl("session-1", "artifact-1"), {
      wrapper: createWrapper(),
    });

    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.url).toBeNull();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toContain("500");
  });

  it("does not schedule an immediate refresh when the URL is already within the refresh buffer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        url: "https://media.example.com/current",
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useMediaArtifactUrl("session-1", "artifact-1"), {
      wrapper: createWrapper(),
    });

    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the scheduled refresh timer on unmount", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        url: "https://media.example.com/current",
        expiresAt: Math.floor(Date.now() / 1000) + 61,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderHook(() => useMediaArtifactUrl("session-1", "artifact-1"), {
      wrapper: createWrapper(),
    });

    await flushMicrotasks();
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
