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
      const packageJson = JSON.parse(
        readFileSync(resolve(packageDirectory, "package.json"), "utf8")
      ) as { dependencies: Record<string, string> };

      expect(packageJson.dependencies["@earendil-works/pi-codemode"]).toBe("1.4.0");

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
        bundledSources.some((input) =>
          input.endsWith("node_modules/@earendil-works/pi-codemode/dist/runtime/remote.js")
        )
      ).toBe(true);
      expect(
        bundledSources.filter(
          (input) =>
            input.includes("@earendil-works/pi-codemode/dist/cloudflare") || input.endsWith(".wasm")
        )
      ).toEqual([]);
      expect(bundle).not.toContain("quickjs.wasm");
      expect(
        bundledSources.some((input) =>
          input.includes("@cloudflare/computer/dist/backends/worker-javascript/")
        )
      ).toBe(true);
      expect(
        bundledSources.filter(
          (input) =>
            input.includes("@cloudflare/computer") &&
            (input.includes("/backends/worker-shell/") ||
              input.includes("/backends/container/") ||
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
      expect(
        Object.keys(nodeMetafile.inputs).filter((input) => input.includes("pi-codemode"))
      ).toEqual([]);
    },
    WORKER_BUILD_TIMEOUT_MS
  );
});
