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

test("Boat deployment inputs reach Terraform plan and apply", () => {
  const assignments = [
    "TF_VAR_boat_api_key: ${{ secrets.BOAT_API_KEY }}",
    "TF_VAR_boat_build_api_key: ${{ secrets.BOAT_BUILD_API_KEY }}",
    "TF_VAR_boat_sandbox_access_secret: ${{ secrets.BOAT_SANDBOX_ACCESS_SECRET }}",
  ];
  const planStart = workflow.indexOf("\n  plan:\n");
  const applyStart = workflow.indexOf("\n  apply:\n");
  const jobs = {
    plan: workflow.slice(planStart, applyStart),
    apply: workflow.slice(applyStart),
  };
  for (const [name, job] of Object.entries(jobs)) {
    for (const assignment of assignments) {
      assert.equal(
        job.split(assignment).length - 1,
        1,
        `expected one ${assignment} in the ${name} job`
      );
    }
  }
  assert.match(workflow, /packages\/boat-infra\/\*\*/);
  assert.match(jobs.apply, /Protect current Boat snapshot during rollout/);
  assert.match(jobs.plan, /Protect current Boat snapshot during plan/);
  assert.match(jobs.apply, /timeout-minutes: 90/);
});
