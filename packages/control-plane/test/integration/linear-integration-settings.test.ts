import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

describe("Linear integration settings access", () => {
  beforeEach(cleanD1Tables);

  it("allows only matching actorless global reads, not repo reads or writes", async () => {
    const endpoint = "https://test.local/integration-settings/linear";
    const read = await serviceFetch(endpoint, { service: "linear-bot" });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ integrationId: "linear", settings: null });
    for (const service of ["slack-bot", "github-bot"] as const) {
      expect((await serviceFetch(endpoint, { service })).status).toBe(403);
    }
    for (const path of ["slack", "github", "sandbox"]) {
      expect(
        (
          await serviceFetch(`https://test.local/integration-settings/${path}`, {
            service: "linear-bot",
          })
        ).status
      ).toBe(403);
    }
    for (const path of [`${endpoint}/repos`, `${endpoint}/repos/acme/widgets`]) {
      expect((await serviceFetch(path, { service: "linear-bot" })).status).toBe(403);
    }
    for (const path of [endpoint, `${endpoint}/repos/acme/widgets`]) {
      for (const method of ["PUT", "DELETE"]) {
        expect(
          (
            await serviceFetch(path, {
              service: "linear-bot",
              method,
              ...(method === "PUT" ? { body: JSON.stringify({ settings: {} }) } : {}),
            })
          ).status
        ).toBe(403);
      }
    }
  });

  describe("harness", () => {
    const globalEndpoint = "https://test.local/integration-settings/linear";
    const repoEndpoint = `${globalEndpoint}/repos/acme/widgets`;
    const resolvedEndpoint = `${globalEndpoint}/resolved/acme/widgets`;

    function put(url: string, settings: unknown) {
      return serviceFetch(url, { method: "PUT", body: JSON.stringify({ settings }) });
    }

    async function resolvedHarness(): Promise<string> {
      const res = await serviceFetch(resolvedEndpoint, { service: "linear-bot" });
      expect(res.status).toBe(200);
      return (await res.json<{ config: { harness: string } }>()).config.harness;
    }

    it("resolves to the built-in harness when unconfigured", async () => {
      expect(await resolvedHarness()).toBe("opencode");
    });

    it("resolves the global harness and lets a repository override it", async () => {
      expect((await put(globalEndpoint, { defaults: { harness: "claude" } })).status).toBe(200);
      expect(await resolvedHarness()).toBe("claude");

      expect((await put(repoEndpoint, { harness: "opencode" })).status).toBe(200);
      expect(await resolvedHarness()).toBe("opencode");
    });

    it.each([
      ["global", globalEndpoint, (s: object) => ({ defaults: s })],
      ["repository", repoEndpoint, (s: object) => s],
    ])("rejects an incompatible %s harness and model on save", async (_level, url, wrap) => {
      const rejected = await put(url, wrap({ harness: "claude", model: "openai/gpt-5.5" }));
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain("cannot run on the Claude Agent harness");

      const accepted = await put(
        url,
        wrap({ harness: "claude", model: "anthropic/claude-sonnet-4-6" })
      );
      expect(accepted.status).toBe(200);
      expect((await put(url, wrap({ harness: "codex" }))).status).toBe(400);
    });

    it("accepts a harness and model that only disagree across levels", async () => {
      expect((await put(globalEndpoint, { defaults: { harness: "claude" } })).status).toBe(200);
      expect((await put(repoEndpoint, { model: "openai/gpt-5.5" })).status).toBe(200);

      const res = await serviceFetch(resolvedEndpoint, { service: "linear-bot" });
      expect(await res.json()).toMatchObject({
        config: { harness: "claude", model: "openai/gpt-5.5" },
      });
    });
  });

  it("fails closed on malformed persisted Linear policy", async () => {
    await env.DB.prepare(
      "INSERT INTO integration_settings (integration_id, settings, created_at, updated_at) VALUES ('linear', ?, 1, 1)"
    )
      .bind(JSON.stringify({ defaults: { unboundChannels: "invalid" } }))
      .run();
    expect(
      (
        await serviceFetch("https://test.local/integration-settings/linear", {
          service: "linear-bot",
        })
      ).status
    ).toBeGreaterThanOrEqual(500);
    expect(
      (
        await serviceFetch("https://test.local/integration-settings/linear/resolved/acme/widgets", {
          service: "linear-bot",
        })
      ).status
    ).toBeGreaterThanOrEqual(500);
  });
});
