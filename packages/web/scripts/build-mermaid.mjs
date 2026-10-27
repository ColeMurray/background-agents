import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/mermaid-frame-entry.ts", import.meta.url))],
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
});
const script = outputFiles[0].text;
if (/<\/script/i.test(script)) throw new Error("Renderer bundle is not safe for an inline script");
const hash = createHash("sha256").update(script).digest("base64");
// No script URLs, eval, connections, fonts, nested frames, or external images are allowed.
// The hash permits only this trusted bundle; all Mermaid dependencies execute in its realm.
const policy = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`;
await writeFile(
  new URL("../public/mermaid-renderer.html", import.meta.url),
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><body><script>${script}</script>`
);
