import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packImage, writeBuildResult } from "../../sandbox-images/src/node";
import { buildVercelBaseSnapshot, verifyVercelSnapshot } from "./base-snapshot";
import { createVercelSandboxClient } from "../../control-plane/src/sandbox/providers/vercel/client";

export async function main(): Promise<void> {
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
    let existing: string | undefined;
    if (process.env.OPENINSPECT_IMAGE_CANDIDATE) {
      const candidates = await client.listSnapshots({
        name: process.env.OPENINSPECT_IMAGE_CANDIDATE,
        limit: 2,
      });
      if (candidates.length > 1) throw new Error("Ambiguous Vercel candidate name");
      if (candidates.length === 1) {
        if (candidates[0].status !== "created") throw new Error("Vercel candidate is not ready");
        existing = candidates[0].id;
      }
    }
    if (existing) {
      await verifyVercelSnapshot(client, existing);
      writeBuildResult(existing);
      writeReference(existing);
      return;
    }
    const archive = join(temporary, "bundle.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", packed.directory, "."], { stdio: "inherit" });
    const result = await buildVercelBaseSnapshot(client, {
      runtimeArchive: readFileSync(archive),
      sourceVersion: packed.plan.buildHash,
      namePrefix: process.env.VERCEL_BASE_SNAPSHOT_NAME || "openinspect-base",
      sandboxName: process.env.OPENINSPECT_IMAGE_CANDIDATE,
    });
    writeBuildResult(result.snapshotId);
    writeReference(result.snapshotId);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
function writeReference(reference: string): void {
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex !== -1) {
    const output = process.argv[outputIndex + 1];
    if (!output) throw new Error("--output requires a path");
    writeFileSync(output, reference + "\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
