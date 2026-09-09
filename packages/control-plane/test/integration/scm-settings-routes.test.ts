import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const BASE = "https://test.local/scm-settings";

async function settingsRequest(
  path = "",
  init?: { method?: string; body?: string }
): Promise<Response> {
  return serviceFetch(`${BASE}${path}`, init);
}

describe("SCM settings API", () => {
  beforeEach(cleanD1Tables);

  it("round-trips and deletes normalized global defaults", async () => {
    const empty = await settingsRequest();
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({ settings: null });

    const put = await settingsRequest("", {
      method: "PUT",
      body: JSON.stringify({
        settings: {
          defaults: { alwaysUseDraftMode: true, pullRequestLabel: "  agent-ready  " },
        },
      }),
    });
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({ status: "updated" });

    const stored = await settingsRequest();
    expect(stored.status).toBe(200);
    await expect(stored.json()).resolves.toEqual({
      settings: {
        defaults: { alwaysUseDraftMode: true, pullRequestLabel: "agent-ready" },
      },
    });

    const removed = await settingsRequest("", { method: "DELETE" });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ status: "deleted" });

    await expect(settingsRequest().then((response) => response.json())).resolves.toEqual({
      settings: null,
    });
  });

  it("round-trips a repository override with a nested owner", async () => {
    const path = "/repos/group%2Fplatform/web-app";
    const put = await settingsRequest(path, {
      method: "PUT",
      body: JSON.stringify({
        settings: { alwaysUseDraftMode: false, pullRequestLabel: "  release-ready  " },
      }),
    });

    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({
      status: "updated",
      repo: "group/platform/web-app",
    });

    const list = await settingsRequest("/repos");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({
      repos: [
        {
          repo: "group/platform/web-app",
          settings: { alwaysUseDraftMode: false, pullRequestLabel: "release-ready" },
        },
      ],
    });

    const removed = await settingsRequest(path, { method: "DELETE" });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({
      status: "deleted",
      repo: "group/platform/web-app",
    });
    await expect(settingsRequest("/repos").then((response) => response.json())).resolves.toEqual({
      repos: [],
    });
  });

  it("rejects malformed settings without changing stored values", async () => {
    const globalSettings = { defaults: { alwaysUseDraftMode: true } };
    const repoSettings = { alwaysUseDraftMode: false };
    const seededGlobal = await settingsRequest("", {
      method: "PUT",
      body: JSON.stringify({ settings: globalSettings }),
    });
    expect(seededGlobal.status).toBe(200);
    const seededRepo = await settingsRequest("/repos/acme/web-app", {
      method: "PUT",
      body: JSON.stringify({ settings: repoSettings }),
    });
    expect(seededRepo.status).toBe(200);

    const malformedJson = await settingsRequest("", { method: "PUT", body: "{" });
    expect(malformedJson.status).toBe(400);
    await expect(malformedJson.json()).resolves.toEqual({ error: "Invalid JSON body" });

    const invalidRepoSettings = await settingsRequest("/repos/acme/web-app", {
      method: "PUT",
      body: JSON.stringify({ settings: { alwaysUseDraftMode: "yes" } }),
    });
    expect(invalidRepoSettings.status).toBe(400);
    await expect(invalidRepoSettings.json()).resolves.toMatchObject({
      error: expect.stringContaining("alwaysUseDraftMode must be a boolean"),
    });

    await expect(settingsRequest().then((response) => response.json())).resolves.toEqual({
      settings: globalSettings,
    });
    await expect(settingsRequest("/repos").then((response) => response.json())).resolves.toEqual({
      repos: [{ repo: "acme/web-app", settings: repoSettings }],
    });
  });
});
