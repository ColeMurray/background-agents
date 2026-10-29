import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

describe("Slack integration settings harness", () => {
  const globalEndpoint = "https://test.local/integration-settings/slack";
  const repoEndpoint = `${globalEndpoint}/repos/acme/widgets`;

  beforeEach(cleanD1Tables);

  function put(url: string, settings: unknown) {
    return serviceFetch(url, { method: "PUT", body: JSON.stringify({ settings }) });
  }

  it("round-trips the global harness to the slack-bot service", async () => {
    const saved = await put(globalEndpoint, {
      defaults: { harness: "claude", model: "anthropic/claude-haiku-4-5" },
    });
    expect(saved.status).toBe(200);

    const read = await serviceFetch(globalEndpoint, { service: "slack-bot" });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      integrationId: "slack",
      settings: { defaults: { harness: "claude", model: "anthropic/claude-haiku-4-5" } },
    });
  });

  it("rejects a harness and model it cannot run saved together", async () => {
    const rejected = await put(globalEndpoint, {
      defaults: { harness: "claude", model: "openai/gpt-5.4" },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: 'Model "openai/gpt-5.4" cannot run on the Claude Agent harness.',
    });

    const read = await serviceFetch(globalEndpoint, { service: "slack-bot" });
    expect(await read.json()).toMatchObject({ settings: null });
  });

  it("rejects an unknown harness", async () => {
    expect((await put(globalEndpoint, { defaults: { harness: "codex" } })).status).toBe(400);
  });

  it("rejects a harness at the repository level", async () => {
    expect((await put(repoEndpoint, { harness: "claude" })).status).toBe(400);
  });
});
