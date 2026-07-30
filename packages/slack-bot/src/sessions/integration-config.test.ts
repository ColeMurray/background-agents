import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { getSlackSessionInstructions } from "./integration-config";

function makeEnv(fetch: ReturnType<typeof vi.fn>): Env {
  return {
    SERVICE_AUTH_SECRET: "test-secret",
    CONTROL_PLANE: { fetch },
  } as unknown as Env;
}

describe("getSlackSessionInstructions", () => {
  it("returns configured instructions", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          settings: { defaults: { sessionInstructions: "Prefer minimal diffs." } },
        })
      )
    );

    await expect(getSlackSessionInstructions(makeEnv(fetch))).resolves.toBe(
      "Prefer minimal diffs."
    );
  });

  it("returns undefined when instructions are unset", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ settings: { defaults: {} } })));

    await expect(getSlackSessionInstructions(makeEnv(fetch))).resolves.toBeUndefined();
  });

  it("returns undefined for whitespace-only instructions", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          settings: { defaults: { sessionInstructions: "   \n" } },
        })
      )
    );

    await expect(getSlackSessionInstructions(makeEnv(fetch))).resolves.toBeUndefined();
  });

  it("returns undefined on a non-OK response", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));

    await expect(getSlackSessionInstructions(makeEnv(fetch))).resolves.toBeUndefined();
  });

  it("returns undefined when the fetch throws", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(getSlackSessionInstructions(makeEnv(fetch))).resolves.toBeUndefined();
  });
});
