import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { forwardAutomationEventToScheduler } from "./automation-event";

describe("forwardAutomationEventToScheduler", () => {
  it("omits x-trace-id when the caller did not supply one", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ triggered: 1, skipped: 0 }));
    const env = {
      SCHEDULER: {
        idFromName: vi.fn().mockReturnValue("scheduler-id"),
        get: vi.fn().mockReturnValue({ fetch }),
      },
    } as unknown as Env;

    await forwardAutomationEventToScheduler(env, { source: "webhook" });

    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("x-trace-id")).toBeNull();
  });
});
