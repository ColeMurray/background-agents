import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionIndexStore } from "../db/session-index";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { handleCancelChild } from "./session-children";
import type { SessionRouteContext } from "./session-route";
import { parsePattern } from "./shared";

describe("handleCancelChild", () => {
  afterEach(() => vi.restoreAllMocks());

  it("attempts every descendant and aggregates non-conflict failures", async () => {
    vi.spyOn(SessionIndexStore.prototype, "isChildOf").mockResolvedValue(true);
    vi.spyOn(SessionIndexStore.prototype, "listActiveDescendantIds").mockResolvedValue([
      "deep-failure",
      "later-success",
      "shallow-failure",
    ]);

    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async (sessionId) => {
      if (sessionId === "child") return Response.json({ status: "cancelled" });
      if (sessionId === "deep-failure" || sessionId === "shallow-failure") {
        return Response.json({ error: "failure" }, { status: 500 });
      }
      return Response.json({ status: "cancelled" });
    });
    const match = "/sessions/parent/children/child/cancel".match(
      parsePattern("/sessions/:id/children/:childId/cancel")
    );
    if (!match) throw new Error("Expected route match");

    const response = await handleCancelChild(
      new Request("https://test.local/sessions/parent/children/child/cancel", { method: "POST" }),
      {} as Env,
      match,
      {
        db: {} as SessionRouteContext["db"],
        metrics: {} as SessionRouteContext["metrics"],
        request_id: "request-id",
        trace_id: "trace-id",
        sessionRuntime: { fetch },
      }
    );

    expect(fetch.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "child",
      "deep-failure",
      "later-success",
      "shallow-failure",
    ]);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Nested tasks could not be cancelled: deep-failure, shallow-failure",
      cancelledDescendantIds: ["later-success"],
    });
  });
});
