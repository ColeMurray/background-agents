import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/compose-smoke.yml", import.meta.url),
  "utf8"
);
// Execute the workflow's script, not a second implementation of the policy.
const changesStep = workflow.match(
  / {6}- name: Check for changes affecting Compose smoke\n([\s\S]*?)(?=\n {6}- name:)/
)[1];
const script = changesStep
  .split("        run: |\n")[1]
  .split("\n")
  .map((line) => line.slice(10))
  .join("\n");

const unrelated = [
  "README.md",
  "provider-accounts.md",
  "docs/ramp-inspect-agent.md",
  "docs/plans/walkthrough.html",
  "packages/web/src/app/page.tsx",
  "packages/web/public/logo.svg",
  "packages/web/src/app/page.test.tsx",
  "packages/web/src/space and\nnewline.tsx",
  "packages/slack-bot/src/index.ts",
  "packages/github-bot/test/handlers.test.ts",
  "packages/linear-bot/src/webhook-handler.ts",
  "packages/modal-infra/src/web_api.py",
  "packages/daytona-infra/src/toolchain.py",
  "packages/e2b-infra/pyproject.toml",
  "packages/opencomputer-infra/src/build-template.ts",
  "packages/sandbox-runtime/src/sandbox_runtime/bridge.py",
  "packages/sandbox-runtime/src/sandbox_runtime/skills/example/SKILL.md",
  "packages/sandbox-runtime/src/sandbox_runtime/tools/slack-notify.js",
  "terraform/environments/production/main.tf",
  "terraform/modules/aws-control-plane/templates/user-data.sh.tftpl",
  "terraform/README.md",
  "packages/control-plane/src/node/host.test.ts",
  "packages/control-plane/src/index.test.ts",
  "packages/shared/src/auth.test.ts",
  "packages/shared/src/types/skills.test.ts",
  "packages/control-plane/test/integration/session.test.ts",
  "packages/control-plane/test/integration/fixtures/requests.json",
  "packages/control-plane/vitest.config.ts",
  "packages/control-plane/vitest.integration.config.ts",
  "packages/shared/vitest.config.ts",
  "packages/control-plane/tsconfig.test.json",
  "packages/shared/tsconfig.test.json",
  ".github/workflows/ci.yml",
  ".github/workflows/ci-python.yml",
  ".github/workflows/deploy-web.yml",
  ".github/workflows/terraform.yml",
  "eslint.config.js",
  "knip.json",
  "ruff.toml",
  ".prettierrc",
  ".prettierignore",
  "vitest.workspace.ts",
  "scripts/lint-complexity.mjs",
  "scripts/lint-sql-portability.test.mjs",
  "scripts/sql-portability-baseline.json",
  "scripts/bootstrap-workspace-owner.ts",
  "scripts/merge-split-users.test.ts",
  "scripts/cf-logs.ts",
  "scripts/check-aws-stack.sh",
  "scripts/d1-migrate.sh",
  "scripts/wrangler-secrets.sh",
];

const required = [
  "packages/control-plane/src/node/main.ts",
  "packages/control-plane/src/session/message-queue.ts",
  "packages/shared/src/service-auth.ts",
  "packages/shared/src/triggers/testing.ts",
  "packages/shared/src/helper.test-support.ts",
  "packages/shared/tsconfig.json",
  "packages/control-plane/tsconfig.json",
  "packages/control-plane/Dockerfile",
  "packages/control-plane/docker/entrypoint.sh",
  "packages/control-plane/docker/litestream.yml",
  "packages/control-plane/docker/Caddyfile",
  "docker-compose.yml",
  "docker-compose.smoke.yml",
  "docker-compose.aws.yml",
  ".dockerignore",
  ".env.example",
  "package.json",
  "package-lock.json",
  ".npmrc",
  "packages/web/package.json",
  "packages/web/package-lock.json",
  "packages/web/npm-shrinkwrap.json",
  "packages/web/.npmrc",
  "packages/slack-bot/package.json",
  "packages/github-bot/package.json",
  "packages/linear-bot/package.json",
  "packages/opencomputer-infra/package.json",
  "packages/control-plane/package.json",
  "packages/shared/package.json",
  "packages/sandbox-runtime/src/sandbox_runtime/runtime_manifest.json",
  "packages/sandbox-runtime/src/sandbox_runtime/image_build_callback_env.json",
  "packages/sandbox-runtime/src/sandbox_runtime/new_contract.json",
  "terraform/d1/migrations/0080_example.sql",
  "packages/control-plane/test/smoke/run-smoke.mjs",
  "packages/control-plane/test/smoke/fake-modal-host.mjs",
  "packages/control-plane/test/smoke/new-fixture.json",
  "scripts/compose-smoke.sh",
  "scripts/compose-smoke-paths.test.mjs",
  ".github/workflows/compose-smoke.yml",
  ".github/workflows/new-workflow.yml",
  "packages/new-package/src/index.ts",
  "scripts/new-build-input.sh",
  "unknown.config",
];

test("Compose smoke selects real inputs and keeps unknown changes covered", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "compose-paths-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, "repo");
  mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Smoke filter test");
  git("config", "user.email", "smoke-filter@example.test");
  git("commit", "--quiet", "--allow-empty", "-m", "base");
  let revision = 0;
  function write(file) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), `fixture ${++revision}\n`);
  }
  function commit() {
    git("add", "--all");
    git("commit", "--quiet", "-m", "fixture change");
    return git("rev-parse", "HEAD");
  }
  function expectRun(range, expected) {
    const output = join(scratch, "output");
    const summary = join(scratch, "summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const result = spawnSync("bash", ["-e", "-o", "pipefail"], {
      cwd: repo,
      input: script,
      encoding: "utf8",
      env: { ...env, DIFF_RANGE: range, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8"), `run=${expected}\n`, result.stderr);
  }

  for (const [expected, paths] of [
    [false, unrelated],
    [true, required],
  ]) {
    for (const file of paths) {
      await t.test(`${expected ? "run" : "skip"}: ${JSON.stringify(file)}`, () => {
        const before = git("rev-parse", "HEAD");
        write(file);
        expectRun(`${before}..${commit()}`, expected);
      });
    }
  }

  await t.test("mixed edits and the full multi-commit push run smoke", () => {
    const before = git("rev-parse", "HEAD");
    write("packages/control-plane/src/node/main.ts");
    write("packages/web/src/app/page.tsx");
    const code = commit();
    write("README.md");
    const docs = commit();
    expectRun(`${before}..${docs}`, true);
    expectRun(`${code}..${docs}`, false);
  });

  for (const [from, to] of [
    ["packages/control-plane/src/node/main.ts", "docs/moved.md"],
    ["packages/web/package.json", "docs/old-package.md"],
    ["docs/moved.md", "packages/control-plane/src/node/moved.ts"],
  ]) {
    await t.test(`rename ${from} to ${to} runs smoke`, () => {
      const before = git("rev-parse", "HEAD");
      mkdirSync(dirname(join(repo, to)), { recursive: true });
      git("mv", from, to);
      expectRun(`${before}..${commit()}`, true);
    });
  }

  for (const [file, expected] of [
    ["docs/ramp-inspect-agent.md", false],
    ["terraform/environments/production/main.tf", false],
    ["terraform/d1/migrations/0080_example.sql", true],
    ["packages/control-plane/test/smoke/run-smoke.mjs", true],
  ]) {
    await t.test(`deletion of ${file}`, () => {
      const before = git("rev-parse", "HEAD");
      git("rm", "--quiet", file);
      expectRun(`${before}..${commit()}`, expected);
    });
  }

  await t.test("behind-base docs PR excludes changes made only on main", () => {
    git("switch", "--quiet", "-c", "docs-pr");
    write("README.md");
    const head = commit();
    git("switch", "--quiet", "main");
    write("packages/control-plane/src/node/main.ts");
    const base = commit();
    expectRun(`${base}...${head}`, false);
  });

  await t.test("empty comparisons skip; missing comparisons run", () => {
    expectRun("HEAD..HEAD", false);
    expectRun(`${"0".repeat(40)}..HEAD`, true);
    expectRun("missing-base...HEAD", true);
  });
});
