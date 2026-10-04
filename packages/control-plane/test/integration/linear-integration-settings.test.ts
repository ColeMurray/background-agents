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
