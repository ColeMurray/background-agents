import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packImage, recordCandidate } from "../../sandbox-images/src/node";
import { buildVercelBaseSnapshot, verifyVercelSnapshot } from "./base-snapshot";
import { createVercelSandboxClient } from "../../control-plane/src/sandbox/providers/vercel/client";

async function main(): Promise<void> {
  const root =
    process.env.OPENINSPECT_REPO_ROOT ||
    execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) throw new Error("VERCEL_TOKEN and VERCEL_PROJECT_ID are required");
  if (process.env.VERCEL_RUNTIME && process.env.VERCEL_RUNTIME !== "node24") {
    throw new Error(
      "The Vercel image target requires node24; update targets.json to introduce another substrate"
    );
  }
  const packed = packImage(root, "vercel");
  const client = createVercelSandboxClient({
    token,
    projectId,
    teamId: process.env.VERCEL_TEAM_ID,
    apiBaseUrl: process.env.VERCEL_SANDBOX_API_BASE_URL,
  });
  const temporary = mkdtempSync(join(tmpdir(), "openinspect-vercel-image-"));
  try {
    const existing = process.env.OPENINSPECT_VERIFY_REFERENCE;
    if (existing) {
      const report = await verifyVercelSnapshot(
        client,
        existing,
        process.env.OPENINSPECT_EXPECTED_RECIPE || packed.plan.recipeDigest
      );
      recordCandidate(
        root,
        "vercel",
        `${process.env.VERCEL_TEAM_ID || "personal"}/${projectId}`,
        existing,
        report
      );
      return;
    }
    const archive = join(temporary, "bundle.tar.gz");
    if (
      process.env.OPENINSPECT_IMAGE_CANDIDATE &&
      (
        await client.listSnapshots({
          name: process.env.OPENINSPECT_IMAGE_CANDIDATE,
          limit: 1,
        })
      ).length
    ) {
      throw new Error(
        "Vercel candidate already exists; choose a new name instead of overwriting it"
      );
    }
    execFileSync("tar", ["-czf", archive, "-C", packed.directory, "."], { stdio: "inherit" });
    const result = await buildVercelBaseSnapshot(client, {
      recipeDigest: packed.plan.recipeDigest,
      runtimeArchive: readFileSync(archive),
      sourceVersion: packed.plan.recipeDigest,
      namePrefix: process.env.VERCEL_BASE_SNAPSHOT_NAME || "openinspect-base",
      sandboxName: process.env.OPENINSPECT_IMAGE_CANDIDATE,
    });
    recordCandidate(
      root,
      "vercel",
      `${process.env.VERCEL_TEAM_ID || "personal"}/${projectId}`,
      result.snapshotId,
      result.verification
    );
    const outputIndex = process.argv.indexOf("--output");
    if (outputIndex !== -1) {
      const output = process.argv[outputIndex + 1];
      if (!output) throw new Error("--output requires a path");
      writeFileSync(output, result.snapshotId + "\n");
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
