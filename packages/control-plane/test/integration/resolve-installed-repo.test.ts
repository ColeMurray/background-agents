import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createRouteSourceControlProvider, resolveInstalledRepo } from "../../src/routes/shared";

describe("resolveInstalledRepo", () => {
  it("handles a missing GitHub App configuration without leaking an unhandled rejection", async () => {
    const provider = createRouteSourceControlProvider(env);

    await expect(resolveInstalledRepo(provider, "acme", "web")).rejects.toThrow(
      "GitHub App not configured"
    );
  });
});
