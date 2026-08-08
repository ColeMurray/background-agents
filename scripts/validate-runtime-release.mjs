import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const releasePath = "packages/sandbox-runtime/src/sandbox_runtime/release.json";
const release = JSON.parse(readFileSync(releasePath, "utf8"));

assert.match(release.opencode_version, /^\d+\.\d+\.\d+$/, "invalid OpenCode version");
assert.ok(Number.isInteger(release.managed_runtime_version), "invalid managed runtime version");
assert.ok(
  Number.isInteger(release.minimum_compatible_runtime_version),
  "invalid minimum compatible runtime version"
);
assert.ok(
  release.managed_runtime_version >= release.minimum_compatible_runtime_version,
  "managed runtime is below the compatibility floor"
);

const consumers = {
  "packages/modal-infra/src/images/base.py": "from sandbox_runtime.release import OPENCODE_VERSION",
  "packages/daytona-infra/src/toolchain.py": '"release.json"',
  "packages/e2b-infra/build-template.py": 'RUNTIME_SRC / "release.json"',
  "packages/opencomputer-infra/src/build-template.ts":
    'from "../../sandbox-runtime/src/sandbox_runtime/release.json"',
  "packages/control-plane/src/runtime-release.ts":
    'from "../../sandbox-runtime/src/sandbox_runtime/release.json"',
};

for (const [path, expectedReference] of Object.entries(consumers)) {
  const source = readFileSync(path, "utf8");
  assert.ok(source.includes(expectedReference), `${path} does not consume ${releasePath}`);
}

for (const path of [
  "terraform/environments/production/modal.tf",
  "terraform/environments/production/daytona.tf",
  "terraform/environments/production/vercel.tf",
]) {
  const source = readFileSync(path, "utf8");
  assert.ok(source.includes("packages/sandbox-runtime/src"), `${path} omits sandbox-runtime`);
  assert.ok(source.includes('-name "*.json"'), `${path} does not hash release.json`);
}

const releaseOwnedPaths = [
  ...Object.keys(consumers),
  "packages/e2b-infra/e2b.Dockerfile",
  "packages/control-plane/src/image-builds/model.ts",
  "packages/control-plane/src/sandbox/opencomputer-rest-client.ts",
  "packages/control-plane/src/sandbox/providers/vercel/bootstrap.ts",
  "packages/control-plane/src/image-builds/rebuild-policy.test.ts",
  "packages/control-plane/src/image-builds/scheduler.test.ts",
  "packages/control-plane/src/image-builds/workflow.test.ts",
  "packages/control-plane/src/sandbox/lifecycle/image-selection.test.ts",
  "packages/control-plane/src/sandbox/lifecycle/manager.test.ts",
  "packages/control-plane/test/integration/image-build-helpers.ts",
];
const releaseOwnedSource = releaseOwnedPaths.map((path) => readFileSync(path, "utf8")).join("\n");

assert.doesNotMatch(
  releaseOwnedSource,
  /v\d+-opencode-\d+-\d+-\d+|v\d+-managed-provider-runtime/,
  "managed runtime labels must derive from release.json"
);
assert.doesNotMatch(
  releaseOwnedSource,
  /OPENCODE_VERSION\s*=\s*["']\d+\.\d+\.\d+["']|ARG OPENCODE_VERSION=\d+\.\d+\.\d+/,
  "OpenCode pins must derive from release.json"
);

const dockerfile = readFileSync("packages/e2b-infra/e2b.Dockerfile", "utf8");
assert.equal(
  dockerfile.match(/__OPENCODE_VERSION__/g)?.length,
  1,
  "E2B Dockerfile must contain exactly one OpenCode version token"
);

console.log(`Runtime release metadata valid (OpenCode ${release.opencode_version})`);
