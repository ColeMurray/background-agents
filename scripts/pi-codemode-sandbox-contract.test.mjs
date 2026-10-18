import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));

async function read(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function parseJsonc(text) {
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
}

test("the Code Mode sandbox is an isolated, private Worker", async () => {
  const [source, config, packageJson] = await Promise.all([
    read("packages/pi-codemode-sandbox/src/index.ts"),
    read("packages/pi-codemode-sandbox/wrangler.jsonc").then(parseJsonc),
    read("packages/pi-codemode-sandbox/package.json").then(JSON.parse),
  ]);

  assert.match(
    source,
    /CodemodeSandboxDurableObject as CodemodeSandbox/,
    "the deployed class must use the stable CodemodeSandbox name"
  );
  assert.match(source, /new Response\("Not found", \{ status: 404 \}\)/);
  assert.equal(packageJson.dependencies["@earendil-works/pi-codemode"], "1.3.0");
  assert.match(packageJson.scripts.build, /wrangler deploy --dry-run --outdir dist/);

  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["CodemodeSandbox"] }]);
  assert.deepEqual(config.limits, { cpu_ms: 60000 });
  for (const forbiddenKey of [
    "vars",
    "services",
    "routes",
    "durable_objects",
    "kv_namespaces",
    "d1_databases",
    "r2_buckets",
  ]) {
    assert.equal(config[forbiddenKey], undefined);
  }
});

test("Wrangler is the sole production owner of the deployment-scoped sandbox", async () => {
  const terraformDirectory = new URL("../terraform/environments/production/", import.meta.url);
  const terraformFiles = (await readdir(terraformDirectory)).filter((name) => name.endsWith(".tf"));
  const terraformRoot = (
    await Promise.all(
      terraformFiles.map((name) => readFile(new URL(name, terraformDirectory), "utf8"))
    )
  ).join("\n");
  const [workflow, terraform, ownership, deployScript] = await Promise.all([
    read(".github/workflows/deploy-pi-codemode-sandbox.yml"),
    read("terraform/environments/production/workers-control-plane.tf"),
    read("terraform/environments/production/moved.tf"),
    read("scripts/deploy-pi-codemode-sandbox.sh"),
  ]);

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /operation:/);
  assert.match(workflow, /scripts\/deploy-pi-codemode-sandbox\.sh/);
  assert.match(deployScript, /open-inspect-pi-codemode-sandbox-\$\{deployment_name\}/);
  assert.match(deployScript, /wrangler.*deploy/);
  assert.match(deployScript, /wrangler.*rollback/);
  assert.doesNotMatch(terraform, /module "pi_codemode_sandbox_worker"/);
  assert.doesNotMatch(terraformRoot, /module "pi_codemode_sandbox_worker"/);
  assert.doesNotMatch(terraformRoot, /new_sqlite_classes\s*=\s*\["CodemodeSandbox"\]/);
  assert.match(
    ownership,
    /removed\s*\{[\s\S]*from\s*=\s*module\.pi_codemode_sandbox_worker[\s\S]*destroy\s*=\s*false/
  );
});

test("the owner script renders deterministic fresh, upgrade, and rollback commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-codemode-owner-"));
  const fake = join(directory, "wrangler");
  const log = join(directory, "args.log");
  await writeFile(fake, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$WRANGLER_TEST_LOG"\n');
  await chmod(fake, 0o755);
  const env = {
    ...process.env,
    WRANGLER_BIN: fake,
    WRANGLER_TEST_LOG: log,
    DEPLOYMENT_NAME: "canary-7",
    CONFIRM_WORKER_NAME: "open-inspect-pi-codemode-sandbox-canary-7",
    CLOUDFLARE_API_TOKEN: "test-token",
    CLOUDFLARE_ACCOUNT_ID: "test-account",
  };
  try {
    await execFileAsync("bash", ["scripts/deploy-pi-codemode-sandbox.sh", "deploy"], {
      cwd: repositoryDirectory,
      env,
    });
    const deploy = (await readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(deploy.slice(0, 2), ["deploy", "--config"]);
    assert.ok(deploy.includes("open-inspect-pi-codemode-sandbox-canary-7"));
    assert.ok(deploy.includes("--strict"));

    await execFileAsync(
      "bash",
      ["scripts/deploy-pi-codemode-sandbox.sh", "rollback", "version-123"],
      { cwd: repositoryDirectory, env }
    );
    const rollback = (await readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(rollback.slice(0, 2), ["rollback", "version-123"]);
    assert.ok(rollback.includes("open-inspect-pi-codemode-sandbox-canary-7"));
    assert.ok(rollback.includes("--yes"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the real two-Worker lane does not replace integration sharding", async () => {
  const [controlPlane, workflow] = await Promise.all([
    read("packages/control-plane/package.json").then(JSON.parse),
    read(".github/workflows/ci.yml"),
  ]);

  assert.equal(
    controlPlane.scripts["test:integration"],
    "vitest run --config vitest.integration.config.ts"
  );
  assert.match(
    controlPlane.scripts["test:integration:codemode"],
    /PI_CODEMODE_INTEGRATION=true vitest run/
  );
  assert.equal(workflow.split("Run Pi Code Mode two-Worker integration tests").length - 1, 1);
  assert.match(workflow, /test:integration[^\n]+--shard=\$\{\{ matrix\.shard \}\}/);
});
