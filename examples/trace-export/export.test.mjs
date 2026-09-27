import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
    const statePath = join(out, ".resume.json");
    const savedState = await readFile(statePath, "utf8");
    for (const changed of [
      ["--url", "http://localhost:1"],
      ["--scope", "sessions"],
      ["--include", "none"],
      ["--created-before", "2000"],
      ["--created-after", "2000"],
    ]) {
      const next = [...args];
      if (next.includes(changed[0])) next[next.indexOf(changed[0]) + 1] = changed[1];
      else next.push(...changed);
      const mismatch = await run(next);
      assert.equal(mismatch.code, 1);
      assert.match(mismatch.stderr, /Resume parameters do not match/);
    }
    const formatMismatch = await run(args.filter((arg) => arg !== "--compact"));
    assert.equal(formatMismatch.code, 1);
    assert.match(formatMismatch.stderr, /Resume parameters do not match/);
    assert.equal(requests.length, 2);
    await rm(statePath);
    const missing = await run(args);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no resume metadata/);
    assert.equal(requests.length, 2);
    await writeFile(statePath, savedState);
    failSecondPage = false;
    assert.equal((await run(args)).code, 0);
    assert.equal((await run(args)).code, 0);
    assert.equal(requests.length, 3);
    assert.equal(requests[1].searchParams.get("cursor"), "page-2");
    assert.equal(requests[2].searchParams.get("cursor"), "page-2");
    assert.equal(requests[0].searchParams.get("scope"), "runs");
    assert.equal(requests[0].searchParams.get("format"), "compact");
    assert.equal(requests[0].searchParams.get("include"), "messages,events,usage");
    const date = (await readdir(out)).find((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
    const files = await readdir(join(out, date));
    assert.deepEqual(files, ["page-000001.ndjson", "page-000002.ndjson"]);
    assert.match(await readFile(join(out, date, files[0]), "utf8"), /"nextCursor":"page-2"/);
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

test("rejects remote HTTP before sending the session cookie", async () => {
  const out = await mkdtemp(join(tmpdir(), "trace-export-"));
  try {
    for (const url of ["http://example.invalid", "ftp://example.invalid"]) {
      const result = await run(["--url", url, "--out", out]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /--url must use https/);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("does not save a page with an invalid cursor so the same window can be retried", async () => {
  const out = await mkdtemp(join(tmpdir(), "trace-export-"));
  const invalidCursors = [undefined, 42, ""];
  let requests = 0;
  const server = createServer((_request, response) => {
    const nextCursor = invalidCursors[requests++];
    const session = { schemaVersion: 2, type: "session", id: "root" };
    const cursorLine =
      requests <= invalidCursors.length
        ? `${JSON.stringify({ schemaVersion: 2, type: "cursor", nextCursor })}\n`
        : "";
    response.end(`${JSON.stringify(session)}\n${cursorLine}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const args = ["--url", `http://127.0.0.1:${server.address().port}`, "--out", out];
    for (let index = 0; index < invalidCursors.length; index++) {
      const result = await run(args);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Invalid cursor in export page/);
      assert.deepEqual(await readdir(out), [".resume.json"]);
    }
    assert.equal((await run(args)).code, 0);
    assert.equal(requests, 4);
    const date = (await readdir(out)).find((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
    assert.deepEqual(await readdir(join(out, date)), ["page-000001.ndjson"]);
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});
