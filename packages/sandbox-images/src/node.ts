/** Build-time bridge. Never import this module into the control-plane Worker. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ImagePlan {
  provider: string;
  recipeDigest: string;
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

export function recordCandidate(
  root: string,
  provider: string,
  scope: string,
  reference: string,
  report: unknown
): void {
  execFileSync(
    "python3",
    [
      join(root, "packages/sandbox-images/cli.py"),
      "record",
      "--provider",
      provider,
      "--scope",
      scope,
      "--reference",
      reference,
    ],
    { input: JSON.stringify(report), stdio: ["pipe", "inherit", "inherit"] }
  );
}
