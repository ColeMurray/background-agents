import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const packageDirectory = new URL("../", import.meta.url);
const manifestUrl = new URL("dist/artifact-manifest.json", packageDirectory);
const modules = [
  { path: "index.js", contentType: "application/javascript+module" },
  { path: "quickjs.wasm", contentType: "application/wasm" },
];

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function buildManifest() {
  const entries = await Promise.all(
    modules.map(async (module) => {
      const bytes = await readFile(new URL(`dist/${module.path}`, packageDirectory));
      return { ...module, bytes: bytes.byteLength, sha256: hash(bytes) };
    })
  );
  const configText = await readFile(new URL("wrangler.jsonc", packageDirectory), "utf8");
  const config = JSON.parse(configText.replace(/,\s*([}\]])/g, "$1"));
  const migration = config.migrations?.[0];
  const contract = {
    cpuMs: config.limits?.cpu_ms,
    migrationTag: migration?.tag,
    durableObjectClass: migration?.new_sqlite_classes?.[0],
    workersDev: config.workers_dev,
    previewUrls: config.preview_urls,
    bindings: config.durable_objects?.bindings ?? [],
    routes: config.routes ?? [],
    secrets: config.vars ? Object.keys(config.vars) : [],
  };
  const artifactSha256 = hash(JSON.stringify({ modules: entries, contract }));
  return { version: 1, artifactSha256, modules: entries, contract };
}

const generated = await buildManifest();
if (process.argv.includes("--verify")) {
  const stored = JSON.parse(await readFile(manifestUrl, "utf8"));
  if (JSON.stringify(stored) !== JSON.stringify(generated)) {
    throw new Error("Code Mode artifact manifest does not match the built JS/WASM bytes");
  }
  process.stdout.write(`${generated.artifactSha256}\n`);
} else {
  await writeFile(manifestUrl, `${JSON.stringify(generated, null, 2)}\n`);
}
