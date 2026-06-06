import { writeFileSync } from "node:fs";

import { buildVercelBaseSnapshot } from "../src/sandbox/vercel-base-snapshot";
import { createVercelSandboxClient } from "../src/sandbox/vercel-client";

function env(name: string, fallback = ""): string {
  return process.env[name] || fallback;
}

function requiredEnv(name: string): string {
  const value = env(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a non-empty value`);
  }
  return value;
}

async function main(): Promise<void> {
  const outputPath = getArgValue("--output");
  const token = requiredEnv("VERCEL_TOKEN");
  const projectId = requiredEnv("VERCEL_PROJECT_ID");

  const client = createVercelSandboxClient({
    token,
    projectId,
    teamId: env("VERCEL_TEAM_ID") || undefined,
    apiBaseUrl: env("VERCEL_SANDBOX_API_BASE_URL") || undefined,
  });

  const result = await buildVercelBaseSnapshot(client, {
    runtime: env("VERCEL_RUNTIME") || undefined,
    runtimeRepoUrl: env("VERCEL_RUNTIME_REPO_URL") || undefined,
    runtimeRepoRef: env("VERCEL_RUNTIME_REPO_REF") || undefined,
    sourceVersion: env("GITHUB_SHA") || env("VERCEL_BASE_SNAPSHOT_SOURCE_VERSION") || undefined,
  });

  if (outputPath) {
    writeFileSync(outputPath, `${result.snapshotId}\n`, { encoding: "utf8" });
  } else {
    process.stdout.write(`${result.snapshotId}\n`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
