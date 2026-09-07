/** Build-time bridge. Never import this module into the control-plane Worker. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ImagePlan {
  provider: string;
  buildHash: string;
  runtimeVersion: string;
  runtimeEnv: Record<string, string>;
  target: { base: string; user: string; home: string };
}

export function packImage(
  root: string,
  provider: string
): { directory: string; plan: ImagePlan; files: string[] } {
  const directory = execFileSync(
    "python3",
    [join(root, "packages/sandbox-images/cli.py"), "pack", "--root", root, "--provider", provider],
    { encoding: "utf8" }
  ).trim();
  return {
    directory,
    plan: JSON.parse(readFileSync(join(directory, "build-config.json"), "utf8")),
    files: readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((path) =>
      statSync(join(directory, path)).isFile()
    ),
  };
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
