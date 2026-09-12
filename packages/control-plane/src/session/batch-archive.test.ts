import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "./contracts";
import { archiveSessionBatch } from "./batch-archive";

const log = createLogger("batch-archive-test", {}, "error");

describe("archiveSessionBatch", () => {
  it.each(["fetch", "body"])(
    "bounds a stalled %s even when transport ignores cancellation",
    async (stage) => {
      vi.useFakeTimers();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
        return controller.signal;
      });
      try {
        const fetch = vi.fn(async () =>
          stage === "fetch"
            ? new Promise<Response>(() => {})
            : new Response(new ReadableStream<Uint8Array>({}))
        );
        const ids = Array.from({ length: 25 }, (_, i) => String(i));
        const pending = archiveSessionBatch(ids, { fetch }, log);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await pending).toEqual(ids.map((sessionId) => ({ sessionId, outcome: "failed" })));
        expect(fetch).toHaveBeenCalledTimes(5);
        expect(timeout).toHaveBeenCalledOnce();
      } finally {
        timeout.mockRestore();
        vi.useRealTimers();
      }
    }
  );

  it("continues past failures and preserves target order with typed outcomes", async () => {
    const fetch = vi.fn(async (id: string) => {
      if (id === "broken") throw new Error("private infrastructure detail");
      if (id === "missing") return new Response(null, { status: 404 });
      if (id === "invalid") return Response.json({ status: "archived" });
      if (id === "inconsistent") return Response.json({ outcome: "archived" }, { status: 409 });
      if (id === "unavailable") return new Response(null, { status: 503 });
      const outcome =
        id === "queued"
          ? "skipped_queued_work"
          : id === "cancelled"
            ? "skipped_cancelled"
            : id === "already"
              ? "already_archived"
              : "archived";
      return Response.json({ outcome }, { status: outcome.startsWith("skipped") ? 409 : 200 });
    });
    const ids = [
      "broken",
      "missing",
      "queued",
      "cancelled",
      "already",
      "invalid",
      "inconsistent",
      "unavailable",
      "last",
    ];
    expect(await archiveSessionBatch(ids, { fetch }, log)).toEqual([
      { sessionId: "broken", outcome: "failed" },
      { sessionId: "missing", outcome: "not_found" },
      { sessionId: "queued", outcome: "skipped_queued_work" },
      { sessionId: "cancelled", outcome: "skipped_cancelled" },
      { sessionId: "already", outcome: "already_archived" },
      { sessionId: "invalid", outcome: "failed" },
      { sessionId: "inconsistent", outcome: "failed" },
      { sessionId: "unavailable", outcome: "failed" },
      { sessionId: "last", outcome: "archived" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(ids.length);
    expect(fetch).toHaveBeenLastCalledWith("last", SessionInternalPaths.archive, {
      method: "POST",
      signal: expect.any(AbortSignal),
    });
  });

  it("bounds in-flight work while allowing another target to progress as soon as one settles", async () => {
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = vi.fn(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight--;
      return Response.json({ outcome: "archived" });
    });
    const result = archiveSessionBatch(
      Array.from({ length: 8 }, (_, i) => String(i)),
      { fetch },
      log
    );
    expect(fetch).toHaveBeenCalledTimes(5);
    releases[0]();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(6));
    // Drain one completion at a time, including targets admitted by each completion.
    for (let index = 1; index < 8; index++) {
      await vi.waitFor(() => expect(releases[index]).toBeDefined());
      releases[index]();
    }
    expect(await result).toHaveLength(8);
    expect(maxInFlight).toBe(5);
  });

  it("reports an aborted target as failed without blocking later targets", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const fetch = vi.fn(async (id: string, _path: string, init?: RequestInit) => {
        if (id === "slow") {
          await new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
              once: true,
            })
          );
        }
        return Response.json({ outcome: "archived" });
      });
      const pending = archiveSessionBatch(["slow", "fast"], { fetch }, log);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      expect(await pending).toEqual([
        { sessionId: "slow", outcome: "failed" },
        { sessionId: "fast", outcome: "archived" },
      ]);
    } finally {
      timeout.mockRestore();
    }
  });
});
