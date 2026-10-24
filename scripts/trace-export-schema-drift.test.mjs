import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { format, resolveConfig } from "prettier";

/**
 * The published trace-export schema must not drift from the code.
 *
 * The schema in `docs/schemas/` is what a consumer programs against. If the
 * code changes and the file does not, every consumer is wrong in a way no
 * test notices. The generator exists; what was missing was the check that the
 * file is what the generator produces.
 */
const target = new URL("../docs/schemas/trace-export.v2.schema.json", import.meta.url);

async function generate() {
  const result = await build({
    stdin: {
      contents: `import { z } from "zod";
        import { traceExportLineSchema } from "./src/types/trace-export.ts";
        export default z.toJSONSchema(traceExportLineSchema, { io: "input" });`,
      resolveDir: new URL("../packages/shared/", import.meta.url).pathname,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const { default: schema } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
  );
  return format(JSON.stringify(schema), {
    ...(await resolveConfig(target.pathname)),
    parser: "json",
  });
}

test("the published trace-export schema matches the code", async () => {
  const published = await readFile(target, "utf8");
  const generated = await generate();
  assert.equal(
    published.trim(),
    generated.trim(),
    "docs/schemas/trace-export.v2.schema.json is stale; regenerate it with " +
      "node packages/control-plane/scripts/generate-trace-export-schema.mjs"
  );
});

test("the generator is reachable from the repository", async () => {
  const generator = new URL(
    "../packages/control-plane/scripts/generate-trace-export-schema.mjs",
    import.meta.url
  );
  const source = await readFile(generator, "utf8");
  assert.ok(source.includes("trace-export.v2.schema.json"));
  assert.ok(fileURLToPath(target).endsWith("docs/schemas/trace-export.v2.schema.json"));
});
