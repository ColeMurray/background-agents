import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { format, resolveConfig } from "prettier";

const target = new URL("../../../docs/schemas/trace-export.v2.schema.json", import.meta.url);
// Bundle the TypeScript source: shared's tsc output uses extensionless imports,
// which Node ESM cannot load directly.
const result = await build({
  stdin: {
    contents: `import { z } from "zod";
      import { traceExportLineSchema } from "./src/types/trace-export.ts";
      export default z.toJSONSchema(traceExportLineSchema, { io: "input" });`,
    resolveDir: new URL("../../shared/", import.meta.url).pathname,
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { default: schema } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
);
const generated = await format(JSON.stringify(schema), {
  ...(await resolveConfig(target.pathname)),
  parser: "json",
});
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== generated) {
    console.error(
      "Trace export schema is stale. Run node packages/control-plane/scripts/generate-trace-export-schema.mjs"
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(target, generated);
}
