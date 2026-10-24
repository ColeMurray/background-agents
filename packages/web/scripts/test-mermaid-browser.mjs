import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// This opt-in test needs Chromium (CHROME_BIN overrides the executable).
// Unlike jsdom, it exercises the generated asset, opaque origin, CSP, and real network stack.
const root = fileURLToPath(new URL("..", import.meta.url));
const renderer = await readFile(new URL("../public/mermaid-renderer.html", import.meta.url));
const { outputFiles } = await build({
  stdin: {
    resolveDir: root,
    contents: `
      import { renderMermaid } from './src/lib/mermaid-renderer';
      (async () => {
        const normal = 'sequenceDiagram\\n Alice->>Bob: Hello';
        const light = await renderMermaid(normal, false);
        const dark = await renderMermaid(normal, true);
        const base = 'http://localhost:' + location.port + '/blocked?kind=';
        const architecture = await renderMermaid('architecture-beta\\n service a "<img src=' + base + 'architecture>" [A]', false);
        const math = await renderMermaid('sequenceDiagram\\n Alice->>Bob: $$x$$ <img src="' + base + 'math">', false);
        const image = await renderMermaid('flowchart LR\\n A@{ img: "' + base + 'image" }', false);
        await renderMermaid('flowchart LR\\n A-->B\\n classDef default fill:url(' + base + 'css)', false);
        const followup = await renderMermaid(normal, false);
        const themeStyle = image => {
          if (!image) return '';
          const svg = decodeURIComponent(image.src.slice(image.src.indexOf(',') + 1));
          return new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('style')?.textContent.replace(/timeline-mermaid-\\d+/g, 'diagram');
        };
        let opaque = false;
        try { document.querySelector('iframe').contentWindow.document.body; } catch { opaque = true; }
        await new Promise(resolve => setTimeout(resolve, 200));
        await fetch('/result', {
          method: 'POST',
          body: JSON.stringify({
            light: !!light, dark: !!dark, distinctThemes: !!themeStyle(light) && themeStyle(light) !== themeStyle(dark),
            sameLightTheme: themeStyle(light) === themeStyle(followup),
            architecture, math, image, followup: !!followup, opaque,
            parentImages: document.querySelectorAll('img').length,
            frames: document.querySelectorAll('iframe').length,
          }),
        });
      })().catch(error => fetch('/result', { method: 'POST', body: JSON.stringify({ error: String(error) }) }));
    `,
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
});

const requests = [];
let reportReady;
const reported = new Promise((resolve) => {
  reportReady = resolve;
});
const server = createServer((request, response) => {
  if (request.url === "/mermaid-renderer.html") {
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Security-Policy": "sandbox allow-scripts",
    });
    response.end(renderer);
  } else if (request.url === "/bundle.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(outputFiles[0].contents);
  } else if (request.url.startsWith("/blocked")) {
    requests.push(request.url);
    response.end("unexpected resource request");
  } else if (request.url === "/result") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      reportReady(JSON.parse(body));
      response.end("ok");
    });
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end('<body><script src="/bundle.js"></script>');
  }
});

await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
const { port } = server.address();
const profile = await mkdtemp(join(tmpdir(), "mermaid-browser-"));
const browser = spawn(
  process.env.CHROME_BIN || "google-chrome",
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--no-proxy-server",
    "--enable-logging=stderr",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/`,
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
let diagnostics = "";
browser.stderr.on("data", (chunk) => {
  diagnostics += chunk;
});
let timer;
try {
  const report = await Promise.race([
    reported,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Browser verification timed out")), 90_000);
      browser.once("error", reject);
      browser.once("exit", (code, signal) =>
        reject(new Error(`Chromium exited: ${code}, ${signal}`))
      );
    }),
  ]);
  assert.deepEqual(report, {
    light: true,
    dark: true,
    distinctThemes: true,
    sameLightTheme: true,
    architecture: null,
    math: null,
    image: null,
    followup: true,
    opaque: true,
    parentImages: 0,
    frames: 1,
  });
  assert.deepEqual(requests, [], "model-authored resources must not reach the network");
  console.log(
    "Mermaid browser isolation passed: normal light/dark rendering, opaque origin, no parent images, no external requests, and queue recovery."
  );
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  clearTimeout(timer);
  if (browser.pid && browser.exitCode === null && browser.signalCode === null) {
    await new Promise((resolve) => {
      browser.once("exit", resolve);
      browser.kill();
    });
  }
  await new Promise((resolve) => server.close(resolve));
  // Chromium helpers can still flush profile files just after the browser exits.
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
