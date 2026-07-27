import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { getAvailableModels } from "./models";

describe("getAvailableModels", () => {
  it("normalizes valid legacy IDs and filters removed models", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ enabledModels: ["openai/gpt-5.2", "gpt-5.4"] }))
      );
    const env = {
      SERVICE_AUTH_SECRET: "test-secret",
      CONTROL_PLANE: { fetch },
    } as unknown as Env;

    const models = await getAvailableModels(env);

    expect(models.map((model) => model.value)).toEqual(["openai/gpt-5.4"]);
  });
});
