/** Build-time bridge. Never import this module into the control-plane Worker. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ImagePlan {
  provider: string;
  inputHash: string;
  runtimeVersion: string;
  runtimeEnv: Record<string, string>;
  target: { base: string; user: string; home: string };
  inputs: { path: string; mode: number; symlink?: string }[];
}

export function packImage(root: string, provider: string): { directory: string; plan: ImagePlan } {
  const directory = execFileSync(
    "python3",
    [join(root, "packages/sandbox-images/cli.py"), "pack", "--root", root, "--provider", provider],
    { encoding: "utf8" }
  ).trim();
  return { directory, plan: JSON.parse(readFileSync(join(directory, "image-plan.json"), "utf8")) };
}

export function writeBuildResult(reference: string): void {
  const result = JSON.stringify({ reference }) + "\n";
  const output = process.env.OPENINSPECT_IMAGE_RESULT;
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, result);
  } else {
    process.stdout.write(result);
  }
}
