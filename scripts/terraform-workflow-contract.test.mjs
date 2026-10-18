import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/terraform.yml", import.meta.url),
  "utf8"
);

function assertInPlanAndApply(assignment, label) {
  const planStart = workflow.indexOf("\n  plan:\n");
  const applyStart = workflow.indexOf("\n  apply:\n");

  assert.notEqual(planStart, -1, "expected the Terraform plan job");
  assert.notEqual(applyStart, -1, "expected the Terraform apply job");

  const jobs = {
    plan: workflow.slice(planStart, applyStart),
    apply: workflow.slice(applyStart),
  };

  for (const [name, job] of Object.entries(jobs)) {
    const occurrences = job.split(assignment).length - 1;
    assert.equal(occurrences, 1, `expected one ${label} input in the ${name} job`);
  }
}

test("Daytona base snapshot memory reaches Terraform plan and apply", () => {
  assertInPlanAndApply(
    "TF_VAR_daytona_base_snapshot_memory_gib: \"${{ vars.DAYTONA_BASE_SNAPSHOT_MEMORY_GIB || '2' }}\"",
    "Daytona memory"
  );
});

test("Classifier-only Anthropic key reaches Terraform plan and apply", () => {
  assertInPlanAndApply(
    "TF_VAR_classification_anthropic_api_key: ${{ secrets.CLASSIFICATION_ANTHROPIC_API_KEY }}",
    "classifier Anthropic key"
  );
});

// Inputs the workflow deliberately does not take from the environment:
// control_plane_* values are staged per migration (the "Stage Durable Object
// migration" step writes them to an auto.tfvars.json file), and
// project_root is a path inside the checkout.
const NOT_FROM_ENVIRONMENT = new Set([
  "control_plane_migration_tag",
  "control_plane_migration_old_tag",
  "control_plane_new_sqlite_classes",
  "control_plane_deleted_classes",
  // Derived by migration staging. An environment value would override the
  // auto tfvars that preserve the binding after admission is disabled.
  "pi_durable_binding_enabled",
  "mcp_connection_binding_enabled",
  "pi_codemode_sandbox_migration_applied",
  // Validated and written as numeric JSON by the migration staging step.
  "pi_codemode_sandbox_cpu_ms",
  "project_root",
]);

test("Every production Terraform variable reaches plan and apply", async () => {
  const variables = await readFile(
    new URL("../terraform/environments/production/variables.tf", import.meta.url),
    "utf8"
  );
  const declared = [...variables.matchAll(/^variable "([a-z0-9_]+)"/gm)].map((match) => match[1]);
  assert.ok(declared.length > 0, "expected variables in variables.tf");

  const missing = declared.filter((name) => {
    if (NOT_FROM_ENVIRONMENT.has(name)) return false;
    try {
      assertInPlanAndApply(`TF_VAR_${name}:`, name);
      return false;
    } catch {
      return true;
    }
  });
  assert.deepEqual(missing, [], "each variable needs exactly one TF_VAR_ input per job");
});

test("PiSessionDO migration is staged and guarded in plan and apply", () => {
  assertInPlanAndApply("pi_durable_binding_enabled", "Pi binding retention");
  assertInPlanAndApply('"control_plane_migration_tag":"v4"', "Pi migration tag");
  assertInPlanAndApply(
    '\\"control_plane_new_sqlite_classes\\":[\\"PiSessionDO\\"]',
    "Pi SQLite class"
  );
  assertInPlanAndApply(
    "Set ENABLE_DURABLE_OBJECT_BINDINGS=false and apply the PiSessionDO migration first",
    "Pi migration phase guard"
  );
  assertInPlanAndApply(
    "Set ENABLE_DURABLE_OBJECT_BINDINGS=true before disabling Pi Durable",
    "Pi rollback phase guard"
  );
});

test("incremental Durable Object migration preserves existing bindings", async () => {
  const module = await readFile(
    new URL("../terraform/modules/cloudflare-worker/main.tf", import.meta.url),
    "utf8"
  );
  assert.match(
    module,
    /if !contains\(var\.new_sqlite_classes, binding\.class_name\)/,
    "phase one must withhold only newly introduced classes"
  );
});

test("McpConnectionDO remains an explicitly staged binding", async () => {
  const [variables, worker, entrypoint, secrets] = await Promise.all([
    readFile(new URL("../terraform/environments/production/variables.tf", import.meta.url), "utf8"),
    readFile(
      new URL("../terraform/environments/production/workers-control-plane.tf", import.meta.url),
      "utf8"
    ),
    readFile(new URL("../packages/control-plane/src/index.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../terraform/environments/production/service-auth.tf", import.meta.url),
      "utf8"
    ),
  ]);

  assert.match(
    variables,
    /variable "mcp_connection_binding_enabled"[\s\S]*?default\s+=\s+false/,
    "the new binding must remain disabled by default"
  );
  assert.match(
    worker,
    /var\.mcp_connection_binding_enabled \? \{ MCP_CONNECTION = \{ class_name = "McpConnectionDO" \} \} : \{\}/,
    "the binding must be independently staged"
  );
  assert.match(entrypoint, /export \{ McpConnectionDO \}/);
  assert.doesNotMatch(
    worker,
    /MCP_CONNECTIONS_ENABLED/,
    "Terraform must not expose the staging API feature flag in the foundation deploy"
  );
  const broker = await readFile(
    new URL(
      "../packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(
    broker,
    /private readonly mcp = new MCPClientManager/,
    "the dormant manager must not be exposed over Durable Object RPC"
  );
  assert.doesNotMatch(broker, /Lifecycle\.install/);
  assert.match(broker, /await this\.mcp\.closeAllConnections\(\)/);
  assert.match(broker, /DELETE FROM mcp_oauth_storage WHERE connection_id = \?/);
  assert.match(secrets, /random_bytes" "mcp_oauth_encryption_key"/);
  assert.match(worker, /MCP_OAUTH_ENCRYPTION_KEY/);
  assertInPlanAndApply("stage-mcp-connection-do.sh", "MCP Durable Object staging");
});

async function stageMcpMigration(environment) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-do-stage-"));
  try {
    const result = spawnSync(
      "bash",
      [fileURLToPath(new URL("./stage-mcp-connection-do.sh", import.meta.url))],
      {
        cwd: directory,
        env: { ...process.env, ...environment },
        encoding: "utf8",
      }
    );
    let output = null;
    try {
      output = JSON.parse(
        await readFile(join(directory, "mcp-connection-do.auto.tfvars.json"), "utf8")
      );
    } catch {}
    return { ...result, output };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("McpConnectionDO migration stages fresh, upgrade, phase-two, and rollback states", async () => {
  const fresh = await stageMcpMigration({
    CURRENT_CONTROL_PLANE_MIGRATION_TAG: "",
    MCP_CONNECTION_FOUNDATION_ENABLED: "true",
    ENABLE_DURABLE_OBJECT_BINDINGS: "false",
  });
  assert.equal(fresh.status, 0);
  assert.deepEqual(fresh.output, {
    mcp_connection_binding_enabled: true,
    control_plane_migration_tag: "v5",
    control_plane_new_sqlite_classes: ["SessionDO", "PiSessionDO", "McpConnectionDO"],
  });

  const upgrade = await stageMcpMigration({
    CURRENT_CONTROL_PLANE_MIGRATION_TAG: "v4",
    MCP_CONNECTION_FOUNDATION_ENABLED: "true",
    ENABLE_DURABLE_OBJECT_BINDINGS: "false",
  });
  assert.equal(upgrade.status, 0);
  assert.deepEqual(upgrade.output, {
    mcp_connection_binding_enabled: true,
    control_plane_migration_tag: "v5",
    control_plane_migration_old_tag: "v4",
    control_plane_new_sqlite_classes: ["McpConnectionDO"],
  });

  for (const foundationEnabled of ["true", "false"]) {
    const deployed = await stageMcpMigration({
      CURRENT_CONTROL_PLANE_MIGRATION_TAG: "v5",
      MCP_CONNECTION_FOUNDATION_ENABLED: foundationEnabled,
      ENABLE_DURABLE_OBJECT_BINDINGS: "true",
    });
    assert.equal(deployed.status, 0);
    assert.deepEqual(deployed.output, { mcp_connection_binding_enabled: true });
  }

  const skipped = await stageMcpMigration({
    CURRENT_CONTROL_PLANE_MIGRATION_TAG: "v4",
    MCP_CONNECTION_FOUNDATION_ENABLED: "false",
    ENABLE_DURABLE_OBJECT_BINDINGS: "true",
  });
  assert.equal(skipped.status, 0);
  assert.equal(skipped.output, null);
});

test("McpConnectionDO migration refuses one-phase and pre-v4 upgrades", async () => {
  const onePhase = await stageMcpMigration({
    CURRENT_CONTROL_PLANE_MIGRATION_TAG: "v4",
    MCP_CONNECTION_FOUNDATION_ENABLED: "true",
    ENABLE_DURABLE_OBJECT_BINDINGS: "true",
  });
  assert.notEqual(onePhase.status, 0);
  assert.match(onePhase.stderr, /ENABLE_DURABLE_OBJECT_BINDINGS=false/);

  const prePi = await stageMcpMigration({
    CURRENT_CONTROL_PLANE_MIGRATION_TAG: "v3",
    MCP_CONNECTION_FOUNDATION_ENABLED: "true",
    ENABLE_DURABLE_OBJECT_BINDINGS: "false",
  });
  assert.notEqual(prePi.status, 0);
  assert.match(prePi.stderr, /requires the PiSessionDO v4 migration/);
});

test("Pi Code Mode sandbox migration completion follows a deployed version", () => {
  assertInPlanAndApply(
    'select(.module == "module.pi_codemode_sandbox_worker" and .type == "cloudflare_workers_deployment"',
    "Code Mode sandbox deployed-version state lookup"
  );
  assertInPlanAndApply(
    '"pi_codemode_sandbox_migration_applied":true',
    "Code Mode sandbox migration completion"
  );
});

test("Pi Code Mode sandbox CPU limit is staged as optional numeric JSON", () => {
  assertInPlanAndApply("PI_CODEMODE_SANDBOX_CPU_MS:", "Code Mode sandbox CPU input");
  assertInPlanAndApply(
    "PI_CODEMODE_SANDBOX_CPU_MS must be a positive integer",
    "Code Mode sandbox CPU validation"
  );
  assertInPlanAndApply("pi-codemode-sandbox-cpu.auto.tfvars.json", "Code Mode sandbox CPU tfvars");
});

test("Terraform runs when root npm deployment inputs change", () => {
  const triggers = workflow.slice(0, workflow.indexOf("\npermissions:\n"));
  for (const path of ['- "package.json"', '- "package-lock.json"']) {
    assert.equal(
      triggers.split(path).length - 1,
      2,
      `expected ${path} in push and pull request path filters`
    );
  }
});
