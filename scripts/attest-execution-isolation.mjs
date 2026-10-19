import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REQUIRED_PROVIDERS = ["modal", "modal-vm", "opencomputer", "daytona", "vercel", "e2b"];
const REQUIRED_ATTACKS = [
  "procEnviron",
  "processCmdline",
  "filesystemCaches",
  "credentialRoutes",
  "inheritedImageSecrets",
  "networkDeny",
  "uidGidPermissions",
];
export const EXECUTION_ARTIFACT_INPUTS = [
  "packages/sandbox-runtime/src/sandbox_runtime/runtime_manifest.json",
  "packages/sandbox-runtime/src/sandbox_runtime/execution_artifact_manifest.json",
  "packages/sandbox-runtime/src/sandbox_runtime/command_runner.py",
  "packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py",
  "packages/sandbox-runtime/src/sandbox_runtime/execution_auth.py",
  "packages/sandbox-runtime/src/sandbox_runtime/execution_bridge.py",
  "packages/sandbox-runtime/src/sandbox_runtime/execution_isolation.py",
  "packages/sandbox-runtime/src/sandbox_runtime/runtime_config.py",
  "packages/sandbox-runtime/src/sandbox_runtime/supervisor.py",
  "packages/sandbox-images/install/install.sh",
  "packages/sandbox-images/install/execution-filesystem.sh",
  "packages/sandbox-images/verify/execution_smoke.py",
];

async function artifactDigest(root) {
  const digest = createHash("sha256");
  for (const relative of EXECUTION_ARTIFACT_INPUTS) {
    digest.update(relative);
    digest.update("\0");
    digest.update(await readFile(new URL(relative, root)));
  }
  return digest.digest("hex");
}

export async function verifyExecutionIsolationEvidence(
  evidence,
  root = new URL("../", import.meta.url)
) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("Execution isolation evidence must be an object");
  }
  const runtime = JSON.parse(
    await readFile(
      new URL("packages/sandbox-runtime/src/sandbox_runtime/runtime_manifest.json", root)
    )
  );
  const expectedDigest = await artifactDigest(root);
  if (runtime.generation < 78 || evidence.runtimeVersion !== runtime.runtimeVersion) {
    throw new Error("Execution evidence does not cover runtime generation 78+");
  }
  if (evidence.artifactSha256 !== expectedDigest) {
    throw new Error("Execution artifact digest does not match the reviewed inputs");
  }
  const providers = evidence.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error("Execution provider evidence is missing");
  }
  if (
    JSON.stringify(Object.keys(providers).sort()) !== JSON.stringify([...REQUIRED_PROVIDERS].sort())
  ) {
    throw new Error("Execution evidence must cover every provider adapter");
  }
  for (const provider of REQUIRED_PROVIDERS) {
    const record = providers[provider];
    if (!record || !["passed", "canary_blocked"].includes(record.status)) {
      throw new Error(`${provider} has no execution isolation verdict`);
    }
    if (record.status === "canary_blocked") {
      if (!Array.isArray(record.limitations) || record.limitations.length === 0) {
        throw new Error(`${provider} must record why execution remains canary-blocked`);
      }
      continue;
    }
    if (
      !record.attacks ||
      REQUIRED_ATTACKS.some((attack) => record.attacks[attack] !== "passed") ||
      JSON.stringify(record.allowedDomains) !==
        JSON.stringify([
          record.controlPlaneHost,
          "registry.npmjs.org",
          "pypi.org",
          "files.pythonhosted.org",
        ])
    ) {
      throw new Error(`${provider} did not pass every isolation attack and exact network profile`);
    }
  }
  return { runtimeVersion: runtime.runtimeVersion, artifactSha256: expectedDigest, providers };
}

async function main() {
  const path = process.env.EXECUTION_ISOLATION_EVIDENCE;
  if (!path) throw new Error("EXECUTION_ISOLATION_EVIDENCE is required");
  const evidence = JSON.parse(await readFile(path, "utf8"));
  process.stdout.write(
    `${JSON.stringify(await verifyExecutionIsolationEvidence(evidence), null, 2)}\n`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
