import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/terraform.yml", import.meta.url),
  "utf8"
);

test("Modal Docker provisioning and admission flags reach Terraform plan and apply", () => {
  const assignments = [
    "TF_VAR_provision_modal_vm_sandboxes: \"${{ vars.PROVISION_MODAL_VM_SANDBOXES || secrets.PROVISION_MODAL_VM_SANDBOXES || 'false' }}\"",
    "TF_VAR_enable_modal_vm_sandboxes: \"${{ vars.ENABLE_MODAL_VM_SANDBOXES || secrets.ENABLE_MODAL_VM_SANDBOXES || 'false' }}\"",
  ];
  const planStart = workflow.indexOf("\n  plan:\n");
  const applyStart = workflow.indexOf("\n  apply:\n");
  const jobs = { plan: workflow.slice(planStart, applyStart), apply: workflow.slice(applyStart) };

  for (const [name, job] of Object.entries(jobs)) {
    for (const assignment of assignments) {
      const occurrences = job.split(assignment).length - 1;
      assert.equal(occurrences, 1, `expected one ${assignment.split(":")[0]} in the ${name} job`);
    }
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
