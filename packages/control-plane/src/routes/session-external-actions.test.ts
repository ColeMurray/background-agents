import { describe, expect, it, vi } from "vitest";
import { SessionInternalPaths } from "../session/contracts";
import {
  handleExternalActionDecision,
  handleExternalActionStatus,
} from "./session-external-actions";
import type { SessionRuntimeClient } from "../session/runtime-client";

function context() {
  const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => Response.json({ ok: true }));
  return {
    authorization: { userId: "user-1" },
    sessionRuntime: { fetch },
  };
}

describe("session external action API", () => {
  it("proxies status through the binding-only SessionDO route", async () => {
    const ctx = context();
    const response = await handleExternalActionStatus(
      new Request("http://api/sessions/session-1/external-actions/action-1"),
      {} as never,
      { id: "session-1", actionId: "action-1" },
      ctx as never
    );

    expect(response.status).toBe(200);
    expect(ctx.sessionRuntime.fetch).toHaveBeenCalledWith(
      "session-1",
      SessionInternalPaths.externalActionStatus,
      undefined,
      "?actionId=action-1"
    );
  });

  it("forwards only a canonical decision with the admitted actor", async () => {
    const ctx = context();
    const response = await handleExternalActionDecision(
      new Request("http://api/sessions/session-1/external-actions/action-1/decision", {
        method: "POST",
        body: JSON.stringify({ decision: "deny", reason: "Wrong destination" }),
      }),
      {} as never,
      { id: "session-1", actionId: "action-1" },
      ctx as never
    );

    expect(response.status).toBe(200);
    const [, path, init] = ctx.sessionRuntime.fetch.mock.calls[0]!;
    expect(path).toBe(SessionInternalPaths.externalActionDecision);
    expect(init?.headers).toEqual({ "X-External-Action-Actor-ID": "user-1" });
    expect(JSON.parse(String(init?.body))).toEqual({
      actionId: "action-1",
      decision: "deny",
      reason: "Wrong destination",
    });
  });
});
