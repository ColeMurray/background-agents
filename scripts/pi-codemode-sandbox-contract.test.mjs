import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  for (const forbiddenKey of [
    "vars",
    "services",
    "routes",
    "kv_namespaces",
    "d1_databases",
    "r2_buckets",
  ]) {
    assert.equal(config[forbiddenKey], undefined);
  }
});
