import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { getLinearConfig } from "./integration-config";

describe("getLinearConfig", () => {
  it("encodes nested repository owners as one route segment", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ config: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const env = {
      SERVICE_AUTH_SECRET: "test-secret",
      CONTROL_PLANE: { fetch },
    } as unknown as Env;

    await getLinearConfig(env, "group/subgroup/web");

    expect(fetch).toHaveBeenCalledWith(
      "https://internal/integration-settings/linear/resolved/group%2Fsubgroup/web",
      expect.any(Object)
    );
  });
});
