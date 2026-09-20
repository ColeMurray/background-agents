import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/terraform.yml", import.meta.url),
  "utf8"
);
const planStart = workflow.indexOf("\n  plan:\n");
const applyStart = workflow.indexOf("\n  apply:\n");
assert.notEqual(planStart, -1, "expected the Terraform plan job");
assert.notEqual(applyStart, -1, "expected the Terraform apply job");
const plan = workflow.slice(planStart, applyStart);
const apply = workflow.slice(applyStart);

test("PR plans reuse an explicit or currently deployed Daytona digest", () => {
  assert.match(plan, /CONFIGURED_DAYTONA_BASE_IMAGE:.*vars\.DAYTONA_BASE_IMAGE/);
  assert.match(plan, /terraform output -raw daytona_base_image/);
  assert.match(plan, /TF_VAR_daytona_base_image=\$reference/);
  assert.doesNotMatch(plan, /docker login|--push|DAYTONA_IMAGE_REPOSITORY/);
});

test("trusted main apply publishes and verifies before Terraform apply", () => {
  assert.match(apply, /packages: write/);
  assert.match(apply, /docker\/login-action@v4/);
  assert.match(apply, /docker\/setup-buildx-action@v4/);
  assert.match(apply, /cli\.py build --provider daytona --output/);
  assert.match(apply, /TF_VAR_daytona_base_image=\$reference/);
  assert.ok(
    apply.indexOf("Publish and natively verify Daytona image") < apply.indexOf("Terraform Apply"),
    "publication gate must precede apply"
  );
});

test("obsolete Daytona snapshot inputs are absent", () => {
  assert.doesNotMatch(workflow, /DAYTONA_BASE_SNAPSHOT|daytona_base_snapshot/);
});
