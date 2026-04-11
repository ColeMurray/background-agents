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
});
