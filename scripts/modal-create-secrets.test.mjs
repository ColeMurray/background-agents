// What `terraform/modules/modal-app/scripts/create-secrets.sh` does when Modal
// rejects a secret update.
//
// Terraform records the new secrets hash once the provisioner exits 0 and never
// re-runs it for the same configuration. A failure that only warns would leave
// the old secret values -- including a credential the operator just cleared --
// in place for good, so the script must fail the apply instead. `uv` is
// replaced with a stub that records each call and fails on demand.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = fileURLToPath(
  new URL("../terraform/modules/modal-app/scripts/create-secrets.sh", import.meta.url)
);

const UV_STUB = `#!/bin/bash
# Stand-in for \`uv run --directory <path> modal secret create <name> ...\`.
echo "$*" >>"$STUB_DIR/calls"
[[ "$7" == "$FAIL_SECRET" ]] && exit 1
exit 0
`;

const SECRETS = [
  { name: "llm-api-keys", values: { ANTHROPIC_API_KEY: "" } },
  { name: "internal-api", values: { MODAL_API_SECRET: "test-secret" } },
];

function run({ failSecret = "" } = {}) {
  const stubDir = mkdtempSync(join(tmpdir(), "modal-create-secrets-"));
  const uv = join(stubDir, "uv");
  writeFileSync(uv, UV_STUB);
  chmodSync(uv, 0o755);

  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      STUB_DIR: stubDir,
      FAIL_SECRET: failSecret,
      MODAL_ENVIRONMENT: "test",
      DEPLOY_PATH: stubDir,
      SECRETS_JSON: JSON.stringify(SECRETS),
    },
  });
  const callsPath = join(stubDir, "calls");
  const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n") : [];
  return { ...result, calls, stubDir };
}

test("replaces every secret, keeping empty values so cleared keys are overwritten", () => {
  const result = run();

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls, [
    `run --directory ${result.stubDir} modal secret create llm-api-keys ANTHROPIC_API_KEY= --force`,
    `run --directory ${result.stubDir} modal secret create internal-api MODAL_API_SECRET=test-secret --force`,
  ]);
});

test("fails the apply when Modal rejects a secret update", () => {
  const result = run({ failSecret: "llm-api-keys" });

  assert.notEqual(result.status, 0, "a failed secret update must not report success");
  assert.match(result.stdout, /Error: Failed to create secret llm-api-keys/);
  assert.doesNotMatch(result.stdout, /All Modal secrets processed successfully/);
  assert.equal(result.calls.length, 1, "no later secret should be attempted after a failure");
});
