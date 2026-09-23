import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("../../..", import.meta.url));
const WORKER_BUILD_TIMEOUT_MS = 60_000;

describe("control-plane worker build", () => {
  it(
    "uses the workerd AsyncLocalStorage implementation",
    () => {
      execFileSync("npm", ["run", "build", "-w", "@open-inspect/shared"], {
        cwd: repositoryDirectory,
        stdio: "pipe",
      });
      execFileSync("npm", ["run", "build"], {
        cwd: packageDirectory,
        stdio: "pipe",
      });

      const bundle = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");

      expect(bundle.includes('"node:async_hooks"')).toBe(true);
      expect(bundle.includes("AsyncLocalStoragePolyfill")).toBe(false);
      expect(bundle.includes("@opentelemetry/semantic-conventions/build/esm/")).toBe(true);
      expect(bundle.includes("@opentelemetry/semantic-conventions/build/src/")).toBe(false);

      // The Node host's adapters (src/node/**) never reach the worker bundle.
      const metafile = JSON.parse(
        readFileSync(new URL("../dist/meta.json", import.meta.url), "utf8")
      ) as { inputs: Record<string, unknown> };
      const bundledSources = Object.keys(metafile.inputs);
      expect(bundledSources).toContain("src/cloudflare/durable-object.ts");
      expect(bundledSources.filter((input) => input.startsWith("src/node/"))).toEqual([]);
    },
    WORKER_BUILD_TIMEOUT_MS
  );
});
