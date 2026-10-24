import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(`Pi Code Mode attestation failed: ${message}`);
}

function object(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${label} is invalid`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} is invalid`);
  return value;
}

export function verifyPiCodemodeAttestation(manifest, observation) {
  const artifact = object(manifest, "artifact manifest");
  const observed = object(observation, "observation");
  if (artifact.version !== 1 || !/^[0-9a-f]{64}$/.test(String(artifact.artifactSha256))) {
    fail("artifact manifest identity is invalid");
  }
  const modules = array(artifact.modules, "artifact modules");
  const modulePaths = modules.map((module) => module?.path).sort();
  if (
    modules.length !== 2 ||
    JSON.stringify(modulePaths) !== JSON.stringify(["index.js", "quickjs.wasm"]) ||
    !modules.every(
      (module) =>
        typeof module?.path === "string" &&
        Number.isSafeInteger(module.bytes) &&
        module.bytes > 0 &&
        /^[0-9a-f]{64}$/.test(String(module.sha256))
    )
  ) {
    fail("exact JS/WASM module hashes are missing");
  }
  const versions = array(observed.deploymentVersions, "deployment versions");
  if (
    versions.length !== 1 ||
    versions[0]?.versionId !== observed.versionId ||
    versions[0]?.percentage !== 100
  ) {
    fail("the observed deployment is not one version at 100% traffic");
  }
  if (typeof observed.versionId !== "string" || observed.versionId.length === 0) {
    fail("Worker version ID is missing");
  }
  if (typeof observed.etag !== "string" || observed.etag.length === 0) {
    fail("Cloudflare script etag is missing");
  }
  if (
    typeof observed.deploymentMessage !== "string" ||
    !observed.deploymentMessage.includes(`artifact-sha256=${artifact.artifactSha256}`)
  ) {
    fail("deployed version is not bound to the built artifact digest");
  }
  if (observed.cpuMs !== 60_000) fail("effective CPU limit is not 60000 ms");
  if (observed.migrationTag !== "v1") fail("v1 SQLite migration is not observed");
  const exports = object(observed.exports, "Worker exports");
  const durableClass = object(exports.CodemodeSandbox, "CodemodeSandbox export");
  if (
    durableClass.type !== "durable-object" ||
    durableClass.storage !== "sqlite" ||
    (durableClass.state !== undefined && durableClass.state !== "created")
  ) {
    fail("CodemodeSandbox is not a live SQLite Durable Object export");
  }
  for (const [label, value] of [
    ["bindings", observed.bindings],
    ["routes", observed.routes],
    ["custom domains", observed.customDomains],
    ["scheduled triggers", observed.schedules],
    ["secrets", observed.secrets],
  ]) {
    if (array(value, label).length !== 0) fail(`${label} must be empty`);
  }
  if (observed.workersDev !== false || observed.previewUrls !== false) {
    fail("workers.dev and preview URLs must both be disabled");
  }
  const runtime = object(observed.runtime, "runtime canary evidence");
  const runtimeKeys = Object.keys(runtime).sort();
  const expectedRuntimeKeys = [
    "abort",
    "boundedScript",
    "directPiAccess",
    "nestedAuthorizedRead",
    "operationId",
    "sessionId",
    "timelineEventIds",
  ].sort();
  const timelineEventIds = array(runtime.timelineEventIds, "runtime timeline events");
  if (
    typeof runtime.sessionId !== "string" ||
    runtime.sessionId.length === 0 ||
    runtime.sessionId.length > 256 ||
    typeof runtime.operationId !== "string" ||
    runtime.operationId.length === 0 ||
    runtime.operationId.length > 256 ||
    runtime.boundedScript !== "passed" ||
    runtime.nestedAuthorizedRead !== "passed" ||
    runtime.abort !== "passed" ||
    runtime.directPiAccess !== false ||
    JSON.stringify(runtimeKeys) !== JSON.stringify(expectedRuntimeKeys) ||
    timelineEventIds.length < 3 ||
    timelineEventIds.length > 16 ||
    !timelineEventIds.every(
      (eventId) => typeof eventId === "string" && eventId.length > 0 && eventId.length <= 256
    )
  ) {
    fail("runtime canary did not prove the canonical SessionDO path");
  }
  return {
    artifactSha256: artifact.artifactSha256,
    modules: modules.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    versionId: observed.versionId,
    etag: observed.etag,
    sessionId: runtime.sessionId,
    operationId: runtime.operationId,
  };
}

async function cloudflareApiJson(path, token) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) fail(`Cloudflare API ${path} returned ${response.status}`);
  const envelope = await response.json();
  if (envelope?.success !== true) fail(`Cloudflare API ${path} was unsuccessful`);
  return envelope.result;
}

function cloudflareJson(path, accountId, token) {
  return cloudflareApiJson(`/accounts/${accountId}${path}`, token);
}

async function observeLive(manifest, runtime) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const workerName = process.env.PI_CODEMODE_WORKER_NAME;
  const expectedVersion = process.env.PI_CODEMODE_EXPECTED_VERSION;
  const zoneIds = (process.env.PI_CODEMODE_ZONE_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!accountId || !token || !workerName || !expectedVersion || zoneIds.length === 0) {
    fail(
      "live observation requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, PI_CODEMODE_WORKER_NAME, PI_CODEMODE_EXPECTED_VERSION, and PI_CODEMODE_ZONE_IDS"
    );
  }
  const deployments = await cloudflareJson(
    `/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
    accountId,
    token
  );
  const latest = array(deployments?.deployments ?? deployments, "Cloudflare deployments")[0];
  const deploymentVersions = array(latest?.versions, "Cloudflare deployment versions").map(
    (entry) => ({ versionId: entry.version_id, percentage: entry.percentage })
  );
  if (deploymentVersions[0]?.versionId !== expectedVersion) {
    fail("active deployment does not match PI_CODEMODE_EXPECTED_VERSION");
  }
  const [version, subdomain, secrets, domains, schedules, zoneRoutes] = await Promise.all([
    cloudflareJson(
      `/workers/scripts/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(expectedVersion)}`,
      accountId,
      token
    ),
    cloudflareJson(
      `/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
      accountId,
      token
    ),
    cloudflareJson(`/workers/scripts/${encodeURIComponent(workerName)}/secrets`, accountId, token),
    cloudflareJson("/workers/domains?per_page=1000", accountId, token),
    cloudflareJson(
      `/workers/scripts/${encodeURIComponent(workerName)}/schedules`,
      accountId,
      token
    ),
    Promise.all(
      zoneIds.map((zoneId) =>
        cloudflareApiJson(
          `/zones/${encodeURIComponent(zoneId)}/workers/routes?per_page=1000`,
          token
        )
      )
    ),
  ]);
  const runtimeConfig = version?.resources?.script_runtime ?? {};
  const script = version?.resources?.script ?? {};
  const message =
    version?.metadata?.annotations?.["workers/message"] ??
    latest?.annotations?.["workers/message"] ??
    "";
  return {
    versionId: version?.id,
    deploymentVersions,
    deploymentMessage: message,
    etag: script.etag,
    cpuMs: runtimeConfig?.limits?.cpu_ms,
    migrationTag: runtimeConfig?.migration_tag,
    exports: runtimeConfig?.exports,
    bindings: version?.resources?.bindings ?? [],
    workersDev: subdomain?.enabled,
    previewUrls: subdomain?.previews_enabled,
    customDomains: array(domains, "Cloudflare custom domains").filter(
      (domain) => domain?.service === workerName
    ),
    routes: zoneRoutes.flat().filter((route) => route?.script === workerName),
    schedules: Array.isArray(schedules) ? schedules : (schedules?.schedules ?? []),
    secrets: array(secrets, "Cloudflare secrets"),
    runtime,
    artifactSha256: manifest.artifactSha256,
  };
}

async function main() {
  const manifestPath = process.env.PI_CODEMODE_ARTIFACT_MANIFEST;
  const runtimePath = process.env.PI_CODEMODE_RUNTIME_EVIDENCE;
  if (!manifestPath || !runtimePath) {
    fail("PI_CODEMODE_ARTIFACT_MANIFEST and PI_CODEMODE_RUNTIME_EVIDENCE are required");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  const observationPath = process.env.PI_CODEMODE_OBSERVATION;
  const observed = observationPath
    ? JSON.parse(await readFile(observationPath, "utf8"))
    : await observeLive(manifest, runtime);
  const observation = { ...object(observed, "observation"), runtime };
  const evidence = verifyPiCodemodeAttestation(manifest, observation);
  if (process.env.PI_CODEMODE_ATTESTATION_OUTPUT) {
    await writeFile(
      process.env.PI_CODEMODE_ATTESTATION_OUTPUT,
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx" }
    );
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
