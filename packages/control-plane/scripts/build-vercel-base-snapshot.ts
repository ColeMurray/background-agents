import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { buildVercelBaseSnapshot } from "../src/sandbox/vercel-base-snapshot";
import { VERCEL_LOCAL_RUNTIME_EXTRACT_DIR } from "../src/sandbox/vercel-bootstrap";
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

  const runtimeArchive = buildLocalRuntimeArchive(
    env("VERCEL_RUNTIME_SOURCE_DIR", "packages/sandbox-runtime")
  );

  const result = await buildVercelBaseSnapshot(client, {
    runtime: env("VERCEL_RUNTIME") || undefined,
    runtimeArchive: runtimeArchive.archive,
    runtimeExtractDir: runtimeArchive.extractDir,
    sandboxName: env("VERCEL_BASE_SNAPSHOT_NAME") || undefined,
    sourceVersion: env("VERCEL_BASE_SNAPSHOT_SOURCE_VERSION") || env("GITHUB_SHA") || undefined,
  });

  if (outputPath) {
    writeFileSync(outputPath, `${result.snapshotId}\n`, { encoding: "utf8" });
  } else {
    process.stdout.write(`${result.snapshotId}\n`);
  }
}

function buildLocalRuntimeArchive(sourceDirInput: string): {
  archive: Uint8Array;
  extractDir: string;
} {
  const sourceDir = resolve(process.cwd(), sourceDirInput);
  const pyprojectPath = join(sourceDir, "pyproject.toml");
  const srcPath = join(sourceDir, "src");

  if (!existsSync(pyprojectPath) || !existsSync(srcPath)) {
    throw new Error(
      `VERCEL_RUNTIME_SOURCE_DIR must point to packages/sandbox-runtime; missing pyproject.toml or src in ${sourceDir}`
    );
  }

  const tempDir = mkdtempSync(join(tmpdir(), "openinspect-vercel-runtime-"));
  const archivePath = join(tempDir, "sandbox-runtime.tar.gz");
  const packageDir = basename(sourceDir);

  try {
    execFileSync(
      "tar",
      [
        "-czf",
        archivePath,
        "-C",
        dirname(sourceDir),
        `${packageDir}/pyproject.toml`,
        `${packageDir}/src`,
      ],
      { stdio: ["ignore", "inherit", "inherit"] }
    );

    const archive = readFileSync(archivePath);
    console.log(
      `Prepared Vercel runtime archive from ${sourceDirInput} (${archive.byteLength} bytes)`
    );

    return {
      archive,
      extractDir: VERCEL_LOCAL_RUNTIME_EXTRACT_DIR,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
