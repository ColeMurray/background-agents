import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IMAGE_RUNTIME_ENTRYPOINT } from "./runtime-entrypoint";

describe("legacy image launch", () => {
  it.each([true, false])(
    "uses image-local evidence, or unknown when the image has no manifest (%s)",
    (hasManifest) => {
      const directory = mkdtempSync(join(tmpdir(), "openinspect-legacy-image-"));
      try {
        const runtime = join(directory, "sandbox_runtime");
        mkdirSync(runtime);
        writeFileSync(join(runtime, "__init__.py"), "");
        writeFileSync(
          join(runtime, "entrypoint.py"),
          'import os; print(os.environ["SANDBOX_VERSION"])'
        );
        if (hasManifest)
          writeFileSync(
            join(runtime, "runtime_manifest.py"),
            'RUNTIME_VERSION="v60-installed-image"'
          );
        const version = execFileSync("python3", ["-c", IMAGE_RUNTIME_ENTRYPOINT], {
          env: { ...process.env, PYTHONPATH: directory, SANDBOX_VERSION: "v999-worker-default" },
          encoding: "utf8",
          cwd: directory,
        }).trim();
        expect(version).toBe(hasManifest ? "v60-installed-image" : "");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
