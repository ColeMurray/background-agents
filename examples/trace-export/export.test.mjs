import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const script = new URL("./export.mjs", import.meta.url).pathname;

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        OPEN_INSPECT_WEB_SECRET: "test-secret",
        OPEN_INSPECT_SESSION_COOKIE: "session=authenticated",
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("pages complete runs, signs each request and resumes from the last cursor", async () => {
  const out = await mkdtemp(join(tmpdir(), "trace-export-"));
  const requests = [];
  let failSecondPage = true;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push(url);
    assert.equal(request.headers.cookie, "session=authenticated");
    assert.equal(request.headers["x-openinspect-service"], "web");
    const [, timestamp, nonce, actual] =
      request.headers["x-openinspect-service-signature"].split(".");
    const query = Array.from(url.searchParams)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    const canonical = `sig1\nweb\n${timestamp}\n${nonce}\nGET\n${url.pathname}\n${query}\n${createHash("sha256").update("").digest("hex")}\n`;
    assert.equal(actual, createHmac("sha256", "test-secret").update(canonical).digest("hex"));
    if (!url.searchParams.has("cursor")) {
      response.end(
        `${JSON.stringify({ schemaVersion: 2, type: "session", id: "root" })}\n${JSON.stringify({ schemaVersion: 2, type: "cursor", nextCursor: "page-2" })}\n`
      );
    } else if (failSecondPage) {
      response.writeHead(503).end("temporary failure");
    } else {
      response.end(`${JSON.stringify({ schemaVersion: 2, type: "session", id: "child" })}\n`);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const args = [
      "--url",
      url,
      "--out",
      out,
      "--scope",
      "runs",
      "--compact",
      "--created-after",
      "1000",
    ];
    const failed = await run(args);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /HTTP 503/);
    failSecondPage = false;
    assert.equal((await run(args)).code, 0);
    assert.equal((await run(args)).code, 0);
    assert.equal(requests.length, 3);
    assert.equal(requests[1].searchParams.get("cursor"), "page-2");
    assert.equal(requests[2].searchParams.get("cursor"), "page-2");
    assert.equal(requests[0].searchParams.get("scope"), "runs");
    assert.equal(requests[0].searchParams.get("format"), "compact");
    assert.equal(requests[0].searchParams.get("include"), "messages,events,usage");
    const [date] = await readdir(out);
    const files = await readdir(join(out, date));
    assert.deepEqual(files, ["page-000001.ndjson", "page-000002.ndjson"]);
    assert.match(await readFile(join(out, date, files[0]), "utf8"), /"nextCursor":"page-2"/);
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});
