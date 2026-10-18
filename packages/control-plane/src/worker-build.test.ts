import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
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

      const bundle = readFileSync(resolve(packageDirectory, "dist/index.js"), "utf8");

      expect(bundle.includes('"node:async_hooks"')).toBe(true);
      expect(bundle.includes("AsyncLocalStoragePolyfill")).toBe(false);
      expect(bundle.includes("@opentelemetry/semantic-conventions/build/esm/")).toBe(true);
      expect(bundle.includes("@opentelemetry/semantic-conventions/build/src/")).toBe(false);

      // The Node host's adapters (src/node/**) never reach the worker bundle.
      const metafile = JSON.parse(
        readFileSync(resolve(packageDirectory, "dist/meta.json"), "utf8")
      ) as { inputs: Record<string, unknown> };
      const bundledSources = Object.keys(metafile.inputs);
      expect(bundledSources).toContain("src/cloudflare/durable-object.ts");
      expect(bundledSources.filter((input) => input.startsWith("src/node/"))).toEqual([]);
      expect(bundledSources).toContain("../../node_modules/@cloudflare/computer/dist/index.js");
      expect(bundledSources).toContain(
        "../../node_modules/@cloudflare/computer/dist/tools/pi-ai.js"
      );
      expect(
        bundledSources.filter(
          (input) =>
            input.includes("@cloudflare/computer") &&
            (input.includes("/backends/") ||
              input.endsWith("/dist/git.js") ||
              input.includes("/modules/git"))
        )
      ).toEqual([]);
      expect(bundledSources.filter((input) => input.includes("node_modules/just-bash/"))).toEqual(
        []
      );

      const nodeMetafile = JSON.parse(
        readFileSync(resolve(packageDirectory, "dist/node/meta.json"), "utf8")
      ) as { inputs: Record<string, unknown> };
      expect(
        Object.keys(nodeMetafile.inputs).filter((input) => input.includes("@cloudflare/computer"))
      ).toEqual([]);
    },
    WORKER_BUILD_TIMEOUT_MS
  );
});
