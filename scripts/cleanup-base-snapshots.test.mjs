import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanup,
  planCleanup,
  validatePolicy,
  managedNamePattern,
} from "./lib/base-snapshot-retention.ts";
import { createSnapshotClient, DaytonaBaseSnapshotClient } from "./lib/base-snapshot-client.ts";

const name = (i) => `openinspect-base-${i.toString(16).padStart(16, "0")}`;
const NOW_MS = Date.UTC(2026, 9, 15);
const DAY_MS = 24 * 60 * 60 * 1000;
const policy = {
  provider: "vercel",
  protectedReferences: [name(0)],
  keepLatest: 1,
  minAgeMs: DAY_MS,
};
const artifact = (i, fields = {}) => ({
  id: `snap-${i}`,
  name: name(i),
  createdAtMs: NOW_MS - (30 - i) * DAY_MS,
  ready: true,
  terminal: true,
  ...fields,
});

test("retention preserves explicit IDs/names, newest successful builds, recent use, and uncertain artifacts", () => {
  const inventory = [
    artifact(0),
    artifact(1),
    artifact(2, { lastUsedAtMs: NOW_MS - 1 }),
    artifact(3, { terminal: false, ready: false }),
    artifact(4, { createdAtMs: NaN }),
    artifact(5, { lastUsedAtMs: NaN }),
    artifact(6, { createdAtMs: NOW_MS - 1 }),
    artifact(7, { name: "openinspect-repo-image-0123456789abcdef" }),
    artifact(8, { ready: false }),
    artifact(9),
  ];
  const plan = planCleanup(
    inventory,
    { ...policy, protectedReferences: [name(0), "snap-1"] },
    NOW_MS
  );
  assert.deepEqual(
    plan.delete.map((item) => item.id),
    ["snap-8", "snap-9"]
  );
  assert.deepEqual(
    plan.keep.map((item) => item.reason),
    ["protected", "protected", "recent", "not-terminal", "unknown-age", "unknown-age", "newest"]
  );
});

test("default policy retains five newest builds plus protected references", () => {
  const inventory = Array.from({ length: 10 }, (_, i) => artifact(i));
  const plan = planCleanup(
    inventory,
    { provider: "vercel", protectedReferences: [name(0)] },
    NOW_MS
  );
  assert.equal(plan.keep.length, 6);
  assert.equal(plan.delete.length, 4);
});

test("policy requires a positive retention count and explicit protection", () => {
  for (const invalid of [
    null,
    [],
    "vercel",
    { ...policy, provider: "modal" },
    { ...policy, keepLatest: "5" },
    { ...policy, keepLatest: 0 },
    { ...policy, keepLatest: 1.5 },
    { ...policy, minAgeMs: -1 },
    { ...policy, minAgeMs: "0" },
    { ...policy, protectedReferences: [1] },
    { ...policy, protectedReferences: [] },
    { ...policy, protectedReferences: [""] },
    { ...policy, provider: "daytona" },
    { ...policy, prefix: "openinspect.*" },
  ])
    assert.throws(() => validatePolicy(invalid));
});

test("managed name matching excludes sessions, manual names, and other prefixes", () => {
  const policies = [
    [{ provider: "vercel", prefix: "openinspect-base" }, "openinspect-base-0123456789abcdef"],
    [{ provider: "daytona", prefix: "my-base" }, "my-base-m4-0123456789abcdef"],
  ];
  for (const [scope, managed] of policies) {
    const pattern = managedNamePattern(scope);
    assert.equal(pattern.test(managed), true);
    for (const other of [
      `${managed}-verify`,
      `${managed}-123`,
      "openinspect-session",
      "my-base-manual",
      "my-base-m0-0123456789abcdef",
    ]) {
      assert.equal(pattern.test(other), false);
    }
  }
});

test("padded protections abort preview and apply even when another protection matches", async () => {
  for (const reference of [` ${name(1)}`, `${name(1)} `, "\tsnap-1\n"]) {
    for (const apply of [false, true]) {
      const deleted = [];
      await assert.rejects(
        cleanup(
          {
            list: async () => [artifact(0), artifact(1), artifact(2)],
            delete: async (snapshot) => deleted.push(snapshot),
          },
          { ...policy, protectedReferences: [name(0), reference] },
          { apply, nowMs: NOW_MS }
        ),
        /policy.protectedReferences/
      );
      assert.deepEqual(deleted, []);
    }
  }
});

test("mismatched protection and duplicate IDs abort before any deletion", async () => {
  for (const inventory of [
    [artifact(1), artifact(2)],
    [artifact(0), artifact(0)],
  ]) {
    const deleted = [];
    await assert.rejects(
      cleanup({ list: async () => inventory, delete: async (item) => deleted.push(item) }, policy, {
        apply: true,
      })
    );
    assert.deepEqual(deleted, []);
  }
});

test("inventory failure prevents deletion and delete failure stops the batch", async () => {
  let deletes = 0;
  await assert.rejects(
    cleanup(
      {
        list: async () => {
          throw new Error("incomplete list");
        },
        delete: async () => deletes++,
      },
      policy,
      { apply: true }
    ),
    /incomplete list/
  );
  assert.equal(deletes, 0);
  await assert.rejects(
    cleanup(
      {
        list: async () => [artifact(0), artifact(1), artifact(2), artifact(3)],
        delete: async () => {
          deletes++;
          throw new Error("provider failure");
        },
      },
      policy,
      { apply: true }
    ),
    /provider failure/
  );
  assert.equal(deletes, 1);
});

test("every protected managed name must resolve before preview or deletion", async () => {
  for (const [provider, prefix, baseName] of [
    ["vercel", "openinspect-base", (i) => `openinspect-base-${i.toString(16).padStart(16, "0")}`],
    ["daytona", "my-base", (i) => `my-base-m2-${i.toString(16).padStart(16, "0")}`],
  ]) {
    const config = {
      ...policy,
      provider,
      prefix,
      protectedReferences: [baseName(0), baseName(11)],
    };
    const inventory = [0, 1, 2].map((i) => artifact(i, { name: baseName(i) }));
    for (const items of [inventory, []]) {
      for (const apply of [false, true]) {
        const deleted = [];
        await assert.rejects(
          cleanup({ list: async () => items, delete: async (item) => deleted.push(item) }, config, {
            apply,
            nowMs: NOW_MS,
          }),
          new RegExp(
            `Protected references match no managed snapshot in inventory: .*${baseName(11)}$`
          )
        );
        assert.deepEqual(deleted, []);
      }
    }
  }
});

test("a mistyped protected ID or name aborts preview and apply beside a valid protection", async () => {
  // snap_1 is the intended rollback target; snap_7 is the deployed base.
  const inventory = Array.from({ length: 8 }, (_, i) =>
    artifact(i, { id: `snap_${i}`, createdAtMs: NOW_MS - (40 - i) * DAY_MS })
  );
  const intended = planCleanup(
    inventory,
    { provider: "vercel", protectedReferences: [name(7), "snap_1"] },
    NOW_MS
  );
  assert.deepEqual(
    intended.delete.map((item) => item.id),
    ["snap_0", "snap_2"]
  );
  for (const typo of ["snap_l", name(1).replace(/1$/, "l")]) {
    for (const apply of [false, true]) {
      const deleted = [];
      await assert.rejects(
        cleanup(
          { list: async () => inventory, delete: async (item) => deleted.push(item) },
          { provider: "vercel", protectedReferences: [name(7), typo] },
          { apply, nowMs: NOW_MS }
        ),
        (error) => error.message.endsWith(`in inventory: ${typo}`)
      );
      assert.deepEqual(deleted, []);
    }
  }
});

test("every unmatched protection is listed, including manual and out-of-scope entries", () => {
  assert.throws(
    () =>
      planCleanup(
        [artifact(0), artifact(1), artifact(2)],
        {
          ...policy,
          protectedReferences: [name(0), "manual-base", "another-prefix-000000000000000b"],
        },
        NOW_MS
      ),
    /in inventory: manual-base, another-prefix-000000000000000b$/
  );
});

function mockFetch(handler) {
  const requests = [];
  return {
    requests,
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      const result = await handler(new URL(url), options);
      if (result instanceof Response) return result;
      return new Response(result == null ? null : JSON.stringify(result), {
        status: result == null ? 204 : 200,
      });
    },
  };
}

test("Daytona paginates all snapshots, scopes names, and deletes by immutable ID", async (t) => {
  const prefix = "openinspect-daytona";
  const baseName = (i) => `${prefix}-m2-${i.toString(16).padStart(16, "0")}`;
  const config = validatePolicy({
    ...policy,
    provider: "daytona",
    prefix,
    protectedReferences: [baseName(0)],
  });
  const mock = mockFetch((url, options) => {
    assert.equal(options.headers.Authorization, "Bearer daytona-test");
    if (options.method === "DELETE") {
      assert.equal(url.pathname, "/api/snapshots/id-1");
      return;
    }
    assert.equal(url.pathname, "/api/snapshots");
    const page = Number(url.searchParams.get("page"));
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("sort"), "createdAt");
    return {
      items: [
        {
          id: `id-${page - 1}`,
          name: baseName(page - 1),
          state: "active",
          createdAt: `2020-01-0${page}T00:00:00Z`,
        },
      ],
      page,
      totalPages: 3,
    };
  });
  t.mock.method(globalThis, "fetch", mock.fetch);
  const client = createSnapshotClient(config, {
    DAYTONA_API_KEY: "daytona-test",
    DAYTONA_API_URL: "https://daytona.test/api",
  });
  const plan = await cleanup(client, config, { apply: true, nowMs: NOW_MS });
  assert.deepEqual(plan.deleted, [{ id: "id-1", name: baseName(1) }]);
  assert.equal(mock.requests.length, 4);
});

test("Vercel resolves managed names and follows sandbox and snapshot cursors with project/team scope", async (t) => {
  const a = "openinspect-base-0000000000000000";
  const b = "openinspect-base-1111111111111111";
  const config = validatePolicy({ ...policy, provider: "vercel", protectedReferences: [a] });
  const mock = mockFetch((url, options) => {
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer vercel-test");
    if (options.method === "GET") assert.equal(url.searchParams.get("project"), "project-1");
    assert.equal(url.searchParams.get("teamId"), "team-1");
    if (options.method === "DELETE") {
      assert.equal(url.pathname, "/api/v2/sandboxes/snapshots/old%2Fid");
      return;
    }
    const limit = Number(url.searchParams.get("limit"));
    if (limit > 50) return new Response(null, { status: 400 });
    assert.ok(limit >= 1, "both Vercel list endpoints require a positive supported limit");
    const cursor = url.searchParams.get("cursor");
    if (url.pathname === "/api/v2/sandboxes") {
      assert.equal(url.searchParams.get("namePrefix"), "openinspect-base-");
      assert.equal(url.searchParams.get("sortBy"), "name");
      return {
        sandboxes: (cursor ? [b, `${a}-verify`] : [a]).map((name) => ({
          name,
          currentSessionId: "session",
          createdAt: 1,
          status: "stopped",
        })),
        pagination: { next: cursor ? null : "sandbox-page2" },
      };
    }
    assert.equal(url.pathname, "/api/v2/sandboxes/snapshots");
    const base = url.searchParams.get("name");
    const id = base === a ? "protected" : cursor ? "latest" : "old/id";
    return {
      snapshots: [
        {
          id,
          sourceSessionId: "session",
          sizeBytes: 1,
          updatedAt: 200,
          status: "created",
          createdAt: cursor ? 200 : 100,
        },
      ],
      pagination: { next: base === b && !cursor ? "snapshot-page2" : null },
    };
  });
  t.mock.method(globalThis, "fetch", mock.fetch);
  const client = createSnapshotClient(config, {
    VERCEL_TOKEN: "vercel-test",
    VERCEL_PROJECT_ID: "project-1",
    VERCEL_TEAM_ID: "team-1",
    VERCEL_SANDBOX_API_BASE_URL: "https://vercel.test/api",
  });
  const result = await cleanup(client, config, { apply: true, nowMs: NOW_MS });
  assert.deepEqual(result.deleted, [{ id: "old/id", name: b }]);
  assert.equal(mock.requests.length, 6);
});

test("Vercel prefix discovery sorts by name", async (t) => {
  const config = validatePolicy({ ...policy, provider: "vercel" });
  const mock = mockFetch((url) => {
    assert.equal(url.pathname, "/api/v2/sandboxes");
    assert.equal(url.searchParams.get("namePrefix"), "openinspect-base-");
    if (url.searchParams.get("sortBy") !== "name") return new Response(null, { status: 400 });
    return { sandboxes: [], pagination: { next: null } };
  });
  t.mock.method(globalThis, "fetch", mock.fetch);
  const client = createSnapshotClient(config, {
    VERCEL_TOKEN: "test",
    VERCEL_PROJECT_ID: "project",
  });
  assert.deepEqual(await client.list(), []);
});

test("malformed or repeated pagination cannot authorize partial cleanup", async (t) => {
  const config = validatePolicy({ ...policy, provider: "vercel" });
  for (const payload of [{ sandboxes: [] }, { sandboxes: [], pagination: { next: "repeated" } }]) {
    const mock = mockFetch(() => payload);
    t.mock.method(globalThis, "fetch", mock.fetch);
    const client = createSnapshotClient(config, {
      VERCEL_TOKEN: "test",
      VERCEL_PROJECT_ID: "project",
    });
    await assert.rejects(cleanup(client, config, { apply: true }), /pagination|invalid.*response/i);
    assert.equal(
      mock.requests.some((request) => request.method === "DELETE"),
      false
    );
  }
});

test("HTTP errors abort inventory, 404 deletion is idempotent, and credentials are not echoed", async (t) => {
  const config = validatePolicy(policy);
  for (const status of [401, 500]) {
    t.mock.method(globalThis, "fetch", async () => new Response("secret", { status }));
    const client = createSnapshotClient(
      { ...config, provider: "daytona" },
      { DAYTONA_API_KEY: "secret", DAYTONA_API_URL: "https://daytona.test/api" }
    );
    await assert.rejects(
      client.list(),
      (error) => error.message.includes(String(status)) && !error.message.includes("secret")
    );
  }
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  for (const [scope, env] of [
    [
      { ...config, provider: "vercel" },
      { VERCEL_TOKEN: "secret", VERCEL_PROJECT_ID: "project" },
    ],
    [
      { ...config, provider: "daytona" },
      { DAYTONA_API_KEY: "secret", DAYTONA_API_URL: "https://daytona.test/api" },
    ],
  ]) {
    await createSnapshotClient(scope, env).delete({ id: "already-gone", name: "already-gone" });
  }
});

test("typed adapters preserve uncertain metadata and normalize only provider readiness", async () => {
  const daytona = new DaytonaBaseSnapshotClient({
    listSnapshots: async () => [
      {
        id: "a",
        name: name(0),
        state: "inactive",
        createdAt: "2020-01-01T00:00:00Z",
        lastUsedAt: "invalid",
      },
      { id: "b", name: name(1), state: "building" },
      { id: "c", name: name(2), state: "build_failed" },
    ],
    deleteSnapshot: async () => {},
  });
  const inventory = await daytona.list();
  assert.deepEqual(
    inventory.map(({ ready, terminal }) => [ready, terminal]),
    [
      [true, true],
      [false, false],
      [false, true],
    ]
  );
  assert.ok(Number.isNaN(inventory[0].lastUsedAtMs));
  assert.ok(Number.isNaN(inventory[1].createdAtMs));
});

test("clients reject missing credentials and insecure non-local URLs", () => {
  assert.throws(() => createSnapshotClient(policy, {}), /VERCEL_TOKEN/);
  assert.throws(
    () =>
      createSnapshotClient(policy, {
        VERCEL_TOKEN: "test",
        VERCEL_PROJECT_ID: "project",
        VERCEL_SANDBOX_API_BASE_URL: "http://provider.example/api",
      }),
    /HTTPS/
  );
});

test("cleanup bounds accumulated base snapshots while preserving the deployed base", async (t) => {
  // Ten distinct source builds have left ten immutable artifacts in the provider.
  const prefix = "openinspect-daytona";
  const baseName = (i) => `${prefix}-m2-${i.toString(16).padStart(16, "0")}`;
  const snapshots = Array.from({ length: 10 }, (_, i) => ({
    id: `snap-${i}`,
    name: baseName(i),
    createdAt: new Date(Date.UTC(2020, 0, i + 1)).toISOString(),
    state: "active",
  }));
  const deleted = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-token");
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/snapshots") {
      const page = Number(url.searchParams.get("page"));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          items: snapshots.slice((page - 1) * 3, page * 3),
          page,
          totalPages: Math.ceil(snapshots.length / 3),
        })
      );
    } else if (req.method === "DELETE" && req.url.startsWith("/api/snapshots/")) {
      const reference = decodeURIComponent(req.url.split("/").at(-1));
      deleted.push(reference);
      const index = snapshots.findIndex((snapshot) => snapshot.id === reference);
      if (index !== -1) snapshots.splice(index, 1);
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const directory = await mkdtemp(join(tmpdir(), "base-retention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policyPath = join(directory, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      provider: "daytona",
      prefix,
      protectedReferences: [baseName(0)],
      keepLatest: 2,
      minAgeMs: 0,
    })
  );
  async function run(args) {
    const child = spawn(process.execPath, ["dist/cleanup-base-snapshots.mjs", ...args], {
      env: {
        ...process.env,
        DAYTONA_API_KEY: "test-token",
        DAYTONA_API_URL: `http://127.0.0.1:${server.address().port}/api`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    const status = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(status, 0, stderr);
    return JSON.parse(stdout);
  }

  const preview = await run(["--policy", policyPath]);
  assert.equal(preview.delete.length, 7);
  assert.deepEqual(deleted, [], "preview must not delete snapshots");
  const result = await run(["--policy", policyPath, "--apply"]);
  assert.equal(result.deleted.length, 7);
  assert.deepEqual(new Set(deleted), new Set(Array.from({ length: 7 }, (_, i) => `snap-${i + 1}`)));
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.name),
    [baseName(0), baseName(8), baseName(9)]
  );
});
