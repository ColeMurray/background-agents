import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

for (const [label, assignment] of [
  [
    "classifier Anthropic key",
    "TF_VAR_classification_anthropic_api_key: ${{ secrets.CLASSIFICATION_ANTHROPIC_API_KEY }}",
  ],
  [
    "classifier OpenAI key",
    "TF_VAR_classification_openai_api_key: ${{ secrets.CLASSIFICATION_OPENAI_API_KEY }}",
  ],
  [
    "classifier Bedrock key",
    "TF_VAR_classification_bedrock_api_key: ${{ secrets.CLASSIFICATION_BEDROCK_API_KEY }}",
  ],
  [
    "classifier model with default",
    "TF_VAR_classification_model: \"${{ vars.CLASSIFICATION_MODEL || 'claude-haiku-4-5' }}\"",
  ],
  [
    "classifier reasoning effort",
    'TF_VAR_classification_reasoning_effort: "${{ vars.CLASSIFICATION_REASONING_EFFORT }}"',
  ],
]) {
  test(`${label} reaches Terraform plan and apply`, () => {
    assertInPlanAndApply(assignment, label);
  });
}

test("Computer preview acknowledgement reaches Terraform plan and apply with a safe default", () => {
  assertInPlanAndApply(
    "TF_VAR_pi_computer_preview_acknowledged: \"${{ vars.PI_COMPUTER_PREVIEW_ACKNOWLEDGED || 'false' }}\"",
    "Computer preview acknowledgement"
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

test("Slack durable ingress reaches plan and apply with a safe default", () => {
  assertInPlanAndApply(
    "TF_VAR_pi_slack_durable_ingress_enabled: \"${{ vars.PI_SLACK_DURABLE_INGRESS_ENABLED || 'false' }}\"",
    "Slack durable ingress safe default"
  );
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

test("Pi Code Mode binding requires explicit Wrangler deployment verification", () => {
  assertInPlanAndApply(
    "TF_VAR_pi_codemode_sandbox_deployment_verified:",
    "Code Mode Wrangler deployment verification"
  );
  assert.equal(workflow.includes("module.pi_codemode_sandbox_worker"), false);
  assert.equal(workflow.includes("pi-codemode-sandbox-migration.auto.tfvars.json"), false);
});

test("Terraform only consumes the verified Wrangler-owned Code Mode worker", async () => {
  const controlPlane = await readFile(
    new URL("../terraform/environments/production/workers-control-plane.tf", import.meta.url),
    "utf8"
  );
  assert.match(controlPlane, /var\.pi_codemode_sandbox_deployment_verified \? \{/);
  assert.match(
    controlPlane,
    /script_name = "open-inspect-pi-codemode-sandbox-\$\{local\.name_suffix\}"/
  );
  assert.doesNotMatch(controlPlane, /module\.pi_codemode_sandbox_worker/);
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
