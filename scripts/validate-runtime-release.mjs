import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stdout } from "node:process";

const releasePath = "packages/sandbox-runtime/src/sandbox_runtime/release.json";
const release = JSON.parse(readFileSync(releasePath, "utf8"));

assert.match(
  release.opencode_version,
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  "invalid OpenCode version"
);
assert.ok(Number.isInteger(release.managed_runtime_version), "invalid managed runtime version");
assert.ok(
  Number.isInteger(release.minimum_compatible_runtime_version),
  "invalid minimum compatible runtime version"
);
assert.ok(release.minimum_compatible_runtime_version > 0, "compatibility floor must be positive");
assert.ok(
  release.managed_runtime_version >= release.minimum_compatible_runtime_version,
  "managed runtime is below the compatibility floor"
);
assert.equal(
  release.managed_sandbox_version,
  `v${release.managed_runtime_version}-opencode-${release.opencode_version.replaceAll(".", "-")}`,
  "managed sandbox label does not match the release metadata"
);

const dockerfile = readFileSync("packages/e2b-infra/e2b.Dockerfile", "utf8");
assert.equal(
  dockerfile.match(/__OPENCODE_VERSION__/g)?.length,
  1,
  "E2B Dockerfile must contain exactly one OpenCode version token"
);
const renderedDockerfile = dockerfile.replace("__OPENCODE_VERSION__", release.opencode_version);
assert.doesNotMatch(
  renderedDockerfile,
  /__OPENCODE_VERSION__/,
  "E2B OpenCode token was not rendered"
);
assert.ok(
  renderedDockerfile.includes(`ARG OPENCODE_VERSION=${release.opencode_version}`),
  "E2B Dockerfile did not receive the release OpenCode version"
);

stdout.write(`Runtime release metadata valid (OpenCode ${release.opencode_version})\n`);
