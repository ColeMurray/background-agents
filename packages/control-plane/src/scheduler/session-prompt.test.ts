import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { isSessionPromptRequestQueued } from "./session-prompt";

const context = { trace_id: "trace-1", request_id: "request-1" };

function envWithResponse(response: () => Response): Env {
  return {
    SESSION: async () => response(),
  } as unknown as Env;
}

describe("isSessionPromptRequestQueued", () => {
  it.each([
    {
      name: "the runtime's missing-session response",
      response: () => Response.json({ error: "Session not found" }, { status: 404 }),
    },
    { name: "an unknown 404", response: () => new Response("Not Found", { status: 404 }) },
    {
      name: "a transient failure",
      response: () => Response.json({ error: "Session not found" }, { status: 503 }),
    },
  ])("fails closed for $name", async ({ response }) => {
    const env = envWithResponse(response);

    await expect(
      isSessionPromptRequestQueued(env, "session-1", "prompt-1", context)
    ).rejects.toThrow("Prompt request lookup failed");
  });
});
