#!/usr/bin/env node
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

function optionsFromArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--compact") {
      options.compact = true;
    } else if (
      ["--url", "--out", "--created-after", "--created-before", "--scope", "--include"].includes(
        flag
      )
    ) {
      if (!args[index + 1]) throw new Error(`Missing value for ${flag}`);
      options[flag.slice(2)] = args[++index];
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!options.url || !options.out) throw new Error("--url and --out are required");
  const base = new URL(options.url);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))
    throw new Error("--url must use https (http is allowed only for loopback)");
  options.url = base.origin;
  if (options.scope && !["sessions", "runs"].includes(options.scope))
    throw new Error("Invalid --scope");
  if (
    options.include &&
    !["none", "messages", "events", "usage", "messages,events,usage"].includes(options.include)
  ) {
    throw new Error("Invalid --include");
  }
  for (const flag of ["created-after", "created-before"]) {
    if (options[flag] && !/^\d+$/.test(options[flag]))
      throw new Error(`Invalid --${flag}: expected epoch milliseconds`);
  }
  return options;
}

function signedHeaders(url, secret, cookie) {
  const timestamp = Date.now();
  const nonce = randomBytes(8).toString("hex");
  const canonicalQuery = Array.from(url.searchParams.entries())
    .sort((a, b) =>
      Buffer.compare(Buffer.from(`${a[0]}\0${a[1]}`), Buffer.from(`${b[0]}\0${b[1]}`))
    )
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const emptyBodyHash = createHash("sha256").update("").digest("hex");
  const canonical = `sig1\nweb\n${timestamp}\n${nonce}\nGET\n${url.pathname}\n${canonicalQuery}\n${emptyBodyHash}\n`;
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return {
    "X-OpenInspect-Service": "web",
    "X-OpenInspect-Service-Signature": `sig1.${timestamp}.${nonce}.${signature}`,
    Cookie: cookie,
    Accept: "application/x-ndjson",
  };
}

async function existingPages(out) {
  const pages = [];
  for (const entry of await readdir(out, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    for (const file of await readdir(join(out, entry.name))) {
      if (/^page-\d+\.ndjson$/.test(file)) pages.push(join(out, entry.name, file));
    }
  }
  return pages.sort();
}

async function main() {
  const options = optionsFromArgs(process.argv.slice(2));
  const secret = process.env.OPEN_INSPECT_WEB_SECRET;
  const cookie = process.env.OPEN_INSPECT_SESSION_COOKIE;
  if (!secret || !cookie)
    throw new Error("Set OPEN_INSPECT_WEB_SECRET and OPEN_INSPECT_SESSION_COOKIE");
  await mkdir(options.out, { recursive: true, mode: 0o700 });
  const include =
    options.include === "none" ? undefined : (options.include ?? "messages,events,usage");
  const resumeState = JSON.stringify({
    url: options.url,
    scope: options.scope ?? "sessions",
    include: include ?? null,
    format: options.compact ? "compact" : "full",
    createdAfter: options["created-after"] ?? null,
    createdBefore: options["created-before"] ?? null,
  });
  const pages = await existingPages(options.out);
  const statePath = join(options.out, ".resume.json");
  let savedState;
  try {
    savedState = await readFile(statePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (pages.length && savedState === undefined)
    throw new Error("Output directory has no resume metadata; use a new output directory");
  if (savedState !== undefined && savedState !== resumeState)
    throw new Error("Resume parameters do not match the existing export");
  if (savedState === undefined)
    await writeFile(statePath, resumeState, { flag: "wx", mode: 0o600 });
  let cursor;
  if (pages.length) {
    const saved = (await readFile(pages.at(-1), "utf8")).trimEnd();
    if (!saved) return;
    const lines = saved.split("\n");
    const last = JSON.parse(lines.at(-1));
    if (last.type !== "cursor") return; // The previous export reached the end of its window.
    cursor = last.nextCursor;
    if (typeof cursor !== "string") throw new Error("Invalid saved cursor");
  }

  let pageNumber = pages.length;
  while (true) {
    const url = new URL("/sessions/export", options.url);
    if (options.scope) url.searchParams.set("scope", options.scope);
    if (include) url.searchParams.set("include", include);
    if (options.compact) url.searchParams.set("format", "compact");
    if (options["created-after"]) url.searchParams.set("createdAfter", options["created-after"]);
    if (options["created-before"]) url.searchParams.set("createdBefore", options["created-before"]);
    url.searchParams.set("limit", include ? "5" : "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      headers: signedHeaders(url, secret, cookie),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Export request failed (HTTP ${response.status})`);
    const text = await response.text();
    const lines = text
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (const line of lines) {
      if (
        line.schemaVersion !== 2 ||
        !["session", "cursor", "session_error", "error"].includes(line.type)
      ) {
        throw new Error("Unexpected export line or schema version");
      }
      if (line.type === "session_error" || line.type === "error") {
        throw new Error(`Export stopped on ${line.type}: ${JSON.stringify(line)}`);
      }
    }
    const last = lines.at(-1);
    if (last && last.type !== "session" && last.type !== "cursor")
      throw new Error("Incomplete export page");
    if (lines.slice(0, -1).some((line) => line.type !== "session"))
      throw new Error("Malformed export page");
    const date = new Date().toISOString().slice(0, 10);
    const directory = join(options.out, date);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = join(directory, `page-${String(++pageNumber).padStart(6, "0")}.ndjson`);
    const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, text.endsWith("\n") ? text : `${text}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, destination);
    if (last?.type !== "cursor") return;
    cursor = last.nextCursor;
    if (typeof cursor !== "string" || !cursor) throw new Error("Invalid cursor in export page");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
