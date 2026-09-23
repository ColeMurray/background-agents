import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/terraform.yml", import.meta.url),
  "utf8"
);

test("Modal launch v1 is default-off and reaches both plan and apply", () => {
  const assignment =
    "TF_VAR_modal_launch_contract_v1_enabled: \"${{ vars.MODAL_LAUNCH_CONTRACT_V1_ENABLED || 'false' }}\"";
  const planStart = workflow.indexOf("\n  plan:\n");
  const applyStart = workflow.indexOf("\n  apply:\n");
  assert.notEqual(planStart, -1);
  assert.notEqual(applyStart, -1);
  for (const job of [workflow.slice(planStart, applyStart), workflow.slice(applyStart)]) {
    assert.equal(job.split(assignment).length - 1, 1);
  }
});

test("Daytona base snapshot memory reaches Terraform plan and apply", () => {
  const assignment =
    "TF_VAR_daytona_base_snapshot_memory_gib: \"${{ vars.DAYTONA_BASE_SNAPSHOT_MEMORY_GIB || '2' }}\"";
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
    assert.equal(occurrences, 1, `expected one Daytona memory input in the ${name} job`);
  }
});
