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

test("Classifier-only Anthropic key reaches Terraform plan and apply", () => {
  assertInPlanAndApply(
    "TF_VAR_classification_anthropic_api_key: ${{ secrets.CLASSIFICATION_ANTHROPIC_API_KEY }}",
    "classifier Anthropic key"
  );
});

// Inputs the workflow deliberately does not take from the environment:
// control_plane_* values are staged per migration (the "Stage SchedulerDO
// deletion migration" step writes them to an auto.tfvars.json file), and
// project_root is a path inside the checkout.
const NOT_FROM_ENVIRONMENT = new Set([
  "control_plane_migration_tag",
  "control_plane_migration_old_tag",
  "control_plane_new_sqlite_classes",
  "control_plane_deleted_classes",
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
