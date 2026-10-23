import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = resolve("scripts/stage-mcp-connection-do.sh");

async function stage(env) {
  const cwd = await mkdtemp(join(tmpdir(), "stage-mcp-do-"));
  const result = spawnSync(script, [], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  let variables = null;
  try {
    variables = JSON.parse(await readFile(join(cwd, "mcp-connection-do.auto.tfvars.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { result, variables };
}

test("keeps the MCP connection foundation absent by default", async () => {
  const { result, variables } = await stage({});
  assert.equal(result.status, 0);
  assert.equal(variables, null);
});

test("stages all required SQLite classes on a fresh deployment", async () => {
  const { result, variables } = await stage({
    MCP_CONNECTION_FOUNDATION_ENABLED: "true",
    ENABLE_DURABLE_OBJECT_BINDINGS: "false",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(variables, {
    mcp_connection_binding_enabled: true,
    pi_durable_binding_enabled: true,
    control_plane_migration_tag: "v5",
    control_plane_new_sqlite_classes: ["SessionDO", "PiSessionDO", "McpConnectionDO"],
  });
});

test("stages only McpConnectionDO after the PiSessionDO migration", async () => {
  const { result, variables } = await stage({
    CURRENT_CONTROL_PLANE_MIGRATION_TAG: "v4",
    MCP_CONNECTION_FOUNDATION_ENABLED: "true",
    ENABLE_DURABLE_OBJECT_BINDINGS: "false",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(variables, {
    mcp_connection_binding_enabled: true,
    control_plane_migration_tag: "v5",
    control_plane_migration_old_tag: "v4",
    control_plane_new_sqlite_classes: ["McpConnectionDO"],
  });
});

test("retains the migrated binding during phase two and rollback", async () => {
  const { result, variables } = await stage({
    CURRENT_CONTROL_PLANE_MIGRATION_TAG: "v5",
    ENABLE_DURABLE_OBJECT_BINDINGS: "true",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(variables, { mcp_connection_binding_enabled: true });
});

test("refuses a one-phase McpConnectionDO deployment", async () => {
  const { result, variables } = await stage({
    CURRENT_CONTROL_PLANE_MIGRATION_TAG: "v4",
    MCP_CONNECTION_FOUNDATION_ENABLED: "true",
    ENABLE_DURABLE_OBJECT_BINDINGS: "true",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /apply the McpConnectionDO migration first/);
  assert.equal(variables, null);
});

test("refuses an incremental McpConnectionDO migration before PiSessionDO v4", async () => {
  const { result, variables } = await stage({
    CURRENT_CONTROL_PLANE_MIGRATION_TAG: "v3",
    MCP_CONNECTION_FOUNDATION_ENABLED: "true",
    ENABLE_DURABLE_OBJECT_BINDINGS: "false",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires the PiSessionDO v4 migration/);
  assert.equal(variables, null);
});
