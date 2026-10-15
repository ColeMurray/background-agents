import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { OpencodePlugin } from "@open-inspect/shared/types/opencode-plugins";
import { OpencodePluginStore } from "../../src/db/opencode-plugins";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";

const URL = "https://test.local/opencode-plugins";
async function create(spec: string, extra = {}) {
  return serviceFetch(URL, { method: "POST", body: JSON.stringify({ spec, ...extra }) });
}

describe("Workspace OpenCode plugins", () => {
  beforeEach(cleanD1Tables);

  it("creates, lists, edits and deletes pinned plugins", async () => {
    const response = await create("@company/audit@1.2.3");
    expect(response.status).toBe(201);
    const plugin = await response.json<OpencodePlugin>();
    expect(plugin).toMatchObject({ spec: "@company/audit@1.2.3", enabled: true, repoScopes: null });
    expect(await (await serviceFetch(URL)).json()).toEqual([plugin]);
    const update = await serviceFetch(`${URL}/${plugin.id}`, {
      method: "PUT",
      body: JSON.stringify({
        spec: plugin.spec,
        revision: plugin.revision,
        enabled: false,
        repoScopes: ["Group/Subgroup/Repo"],
      }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      enabled: false,
      repoScopes: ["group/subgroup/repo"],
    });
    expect((await create(plugin.spec)).status).toBe(409);
    expect((await serviceFetch(`${URL}/${plugin.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await (await serviceFetch(URL)).json()).toEqual([]);
    expect(
      (
        await serviceFetch(`${URL}/${plugin.id}`, {
          method: "PUT",
          body: JSON.stringify({ enabled: true }),
        })
      ).status
    ).toBe(404);
    expect((await serviceFetch(`${URL}/${plugin.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("selects enabled global and matching plugins across every member, including nested owners", async () => {
    await create("global@1.0.0");
    await create("scoped@2.0.0", { repoScopes: ["Group/Subgroup/Repo"] });
    await create("other@1.0.0", { repoScopes: ["unrelated/repo"] });
    await create("disabled@1.0.0", { enabled: false });
    const store = new OpencodePluginStore(sqlDatabase(env.DB));
    expect(await store.forSession([])).toEqual(["global@1.0.0"]);
    expect(
      await store.forSession([
        { repoOwner: "primary", repoName: "repo" },
        { repoOwner: "GROUP/Subgroup", repoName: "Repo" },
      ])
    ).toEqual(["global@1.0.0", "scoped@2.0.0"]);
  });

  it.each([
    "plugin",
    "plugin@latest",
    "plugin@^1.2.3",
    "plugin@1",
    "file:///tmp/p.js",
    "https://example.com/p.js",
    "--help",
    "../p@1.2.3",
  ])("rejects unpinned or non-registry spec %s", async (spec) => {
    expect((await create(spec)).status).toBe(400);
  });

  it("rejects invalid scopes and unknown configuration", async () => {
    for (const extra of [
      { repoScopes: [] },
      { repoScopes: ["repo"] },
      { enabled: "yes" },
      { credentials: "secret" },
    ]) {
      expect((await create("plugin@1.0.0", extra)).status).toBe(400);
    }
  });

  it("requires authentication and denies member mutations while allowing reads", async () => {
    expect((await SELF.fetch(URL)).status).toBe(401);
    const response = await serviceFetch(URL, {
      method: "POST",
      initialUserRole: "member",
      body: JSON.stringify({ spec: "plugin@1.0.0" }),
    });
    expect(response.status).toBe(403);
    expect((await serviceFetch(URL)).status).toBe(200);
    expect(
      (
        await serviceFetch(`${URL}/missing`, {
          method: "PUT",
          body: JSON.stringify({ spec: "plugin@1.0.0" }),
        })
      ).status
    ).toBe(403);
    expect((await serviceFetch(`${URL}/missing`, { method: "DELETE" })).status).toBe(403);
  });
});

it("audits successful plugin management without auditing catalog reads", async () => {
  await cleanD1Tables();
  const created = await create("audit@1.0.0");
  expect(created.status).toBe(201);
  const plugin = await created.json<OpencodePlugin>();
  expect(
    (
      await serviceFetch(`${URL}/${plugin.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      })
    ).status
  ).toBe(200);
  expect((await serviceFetch(`${URL}/${plugin.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await serviceFetch(URL)).status).toBe(200);
  const { results } = await env.DB.prepare(
    "SELECT metadata_json FROM authorization_audit_events WHERE action = 'authorization.request_allowed'"
  ).all<{ metadata_json: string }>();
  const metadata = results.map((row) => JSON.parse(row.metadata_json));
  expect(metadata).toHaveLength(3);
  expect(metadata.map((row) => row.httpMethod).sort()).toEqual(["DELETE", "POST", "PUT"]);
  expect(metadata.every((row) => row.requiredPermission === "opencode_plugins.manage")).toBe(true);
  expect(metadata.map((row) => row.httpStatus).sort()).toEqual([200, 200, 201]);
});

it("fences stale editors and lets a toggle change only enabled", async () => {
  await cleanD1Tables();
  const response = await create("audit@1.0.0");
  const first = await response.json<OpencodePlugin>();
  const second = (await (await serviceFetch(URL)).json<OpencodePlugin[]>())[0];
  const replace = (input: unknown) =>
    serviceFetch(`${URL}/${first.id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  const newer = {
    spec: "audit@2.0.0",
    repoScopes: ["group/private/repo"],
    enabled: true,
    revision: first.revision,
  };
  expect((await replace(newer)).status).toBe(200);
  const currentEditor = (await (await serviceFetch(URL)).json<OpencodePlugin[]>())[0];
  const toggle = await replace({ enabled: false });
  expect(toggle.status).toBe(200);
  expect(await toggle.json()).toMatchObject({ ...newer, enabled: false, revision: 3 });
  expect(
    (
      await replace({
        spec: second.spec,
        repoScopes: second.repoScopes,
        enabled: second.enabled,
        revision: second.revision,
      })
    ).status
  ).toBe(409);
  expect((await replace({ ...newer, revision: currentEditor.revision })).status).toBe(409);
  // A full replacement without a revision must not bypass concurrency checks.
  expect((await replace({ spec: "audit@1.0.0", repoScopes: null, enabled: true })).status).toBe(
    400
  );
  expect(await (await serviceFetch(URL)).json()).toEqual([
    { ...newer, id: first.id, enabled: false, revision: 3 },
  ]);
});
