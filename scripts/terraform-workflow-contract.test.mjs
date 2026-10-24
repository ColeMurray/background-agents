import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

for (const [variable, input] of [
  ["discord_bot_default_model", "DISCORD_BOT_DEFAULT_MODEL"],
  ["discord_bot_harness", "DISCORD_BOT_HARNESS"],
]) {
  test(`${variable} leaves the default to Terraform and preserves Actions overrides`, () => {
    assertInPlanAndApply(
      `TF_VAR_${variable}: "\u0024{{ vars.${input} || secrets.${input} }}"`,
      variable
    );
  });
}

test("plan and apply unset missing Discord overrides before invoking Terraform", () => {
  assertInPlanAndApply(
    'source "$GITHUB_WORKSPACE/scripts/terraform-discord-defaults.sh"',
    "Discord Terraform defaults cleanup"
  );
  const script = fileURLToPath(new URL("./terraform-discord-defaults.sh", import.meta.url));
  const names = ["TF_VAR_discord_bot_default_model", "TF_VAR_discord_bot_harness"];
  for (const values of [undefined, ["", ""], ["openai/gpt-5.5", "opencode"], ["  ", "codex"]]) {
    const env = { ...process.env };
    for (const [i, name] of names.entries()) {
      delete env[name];
      if (values) env[name] = values[i];
    }
    const result = spawnSync(
      "bash",
      [
        "-eu",
        "-c",
        'source "$1"; printf "%s\\n" "${TF_VAR_discord_bot_default_model-unset}" "${TF_VAR_discord_bot_harness-unset}"',
        "test",
        script,
      ],
      { env, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, (values?.[0] ? values : ["unset", "unset"]).join("\n") + "\n");
  }
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
