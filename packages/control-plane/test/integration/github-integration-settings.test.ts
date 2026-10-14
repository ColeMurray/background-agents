import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

describe("GitHub integration settings harness", () => {
  beforeEach(cleanD1Tables);

  const globalEndpoint = "https://test.local/integration-settings/github";
  const repoEndpoint = `${globalEndpoint}/repos/acme/widgets`;
  const resolvedEndpoint = `${globalEndpoint}/resolved/acme/widgets`;

  function put(url: string, settings: unknown) {
    return serviceFetch(url, { method: "PUT", body: JSON.stringify({ settings }) });
  }

  async function resolvedHarness(): Promise<string> {
    const res = await serviceFetch(resolvedEndpoint, { service: "github-bot" });
    expect(res.status).toBe(200);
    return (await res.json<{ config: { harness: string } }>()).config.harness;
  }

  it("resolves to the built-in harness when unconfigured", async () => {
    expect(await resolvedHarness()).toBe("opencode");
  });

  it("resolves the global harness and lets a repository override it", async () => {
    expect(
      (
        await put(globalEndpoint, {
          defaults: { harness: "claude", model: "anthropic/claude-sonnet-4-6" },
        })
      ).status
    ).toBe(200);
    expect(await resolvedHarness()).toBe("claude");

    expect((await put(repoEndpoint, { harness: "opencode" })).status).toBe(200);
    expect(await resolvedHarness()).toBe("opencode");
  });

  it.each([
    ["global", globalEndpoint, (s: object) => ({ defaults: s })],
    ["repository", repoEndpoint, (s: object) => s],
  ])("requires an explicit model with a restricted %s harness", async (_level, url, wrap) => {
    const rejected = await put(url, wrap({ harness: "claude" }));
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("Choose a default model Claude Agent can run.");
    expect(await resolvedHarness()).toBe("opencode");

    expect((await put(url, wrap({ harness: "opencode" }))).status).toBe(200);
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

  it.each([
    ["global", globalEndpoint, (s: object) => ({ defaults: s })],
    ["repository", repoEndpoint, (s: object) => s],
  ])("accepts Codex max reasoning for %s settings", async (_level, url, wrap) => {
    const selection = { harness: "codex", model: "openai/gpt-5.6-sol" };
    expect((await put(url, wrap({ ...selection, reasoningEffort: "max" }))).status).toBe(200);

    const resolved = await serviceFetch(resolvedEndpoint, { service: "github-bot" });
    expect(await resolved.json()).toMatchObject({
      config: { ...selection, reasoningEffort: "max" },
    });
  });

  it.each([
    ["global", globalEndpoint, (s: object) => ({ defaults: s })],
    ["repository", repoEndpoint, (s: object) => s],
  ])("rejects Codex none reasoning for %s settings", async (_level, url, wrap) => {
    const selection = { harness: "codex", model: "openai/gpt-5.6-sol" };
    const rejected = await put(url, wrap({ ...selection, reasoningEffort: "none" }));
    expect(rejected.status).toBe(400);
    expect(await rejected.json<{ error: string }>()).toEqual({
      error: 'Reasoning effort "none" cannot run on openai/gpt-5.6-sol with the Codex harness.',
    });
  });

  it("resolves Codex reasoning inherited by a sparse repository override", async () => {
    expect(
      (
        await put(globalEndpoint, {
          defaults: { harness: "codex", model: "openai/gpt-5.6-sol" },
        })
      ).status
    ).toBe(200);
    expect(
      (await put(repoEndpoint, { model: "openai/gpt-5.6-sol", reasoningEffort: "max" })).status
    ).toBe(200);
    let resolved = await serviceFetch(resolvedEndpoint, { service: "github-bot" });
    expect(await resolved.json()).toMatchObject({ config: { reasoningEffort: "max" } });

    expect((await put(repoEndpoint, { reasoningEffort: "none" })).status).toBe(200);
    resolved = await serviceFetch(resolvedEndpoint, { service: "github-bot" });
    expect(await resolved.json()).toMatchObject({ config: { reasoningEffort: "none" } });
  });

  it("accepts a harness and model that only disagree across levels", async () => {
    expect(
      (
        await put(globalEndpoint, {
          defaults: { harness: "claude", model: "anthropic/claude-sonnet-4-6" },
        })
      ).status
    ).toBe(200);
    expect((await put(repoEndpoint, { model: "openai/gpt-5.5" })).status).toBe(200);

    const res = await serviceFetch(resolvedEndpoint, { service: "github-bot" });
    expect(await res.json()).toMatchObject({
      config: { harness: "claude", model: "openai/gpt-5.5" },
    });
  });
});
