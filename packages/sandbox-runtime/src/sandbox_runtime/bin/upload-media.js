#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const BRIDGE_URL = process.env.CONTROL_PLANE_URL || "http://localhost:8787";
const BRIDGE_TOKEN = process.env.SANDBOX_AUTH_TOKEN;
const CURRENT_MESSAGE_ID_FILE =
  process.env.OPENINSPECT_CURRENT_MESSAGE_ID_FILE || "/tmp/openinspect-current-message-id";

if (!BRIDGE_TOKEN) {
  console.error("SANDBOX_AUTH_TOKEN not set");
  process.exit(1);
}

function getSessionId() {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}");
    return config.sessionId || config.session_id || "";
  } catch {
    return "";
  }
}

async function bridgeFetch(urlPath, options = {}) {
  const sessionId = getSessionId();
  if (!sessionId) {
    throw new Error("Session ID not found in SESSION_CONFIG environment variable");
  }
  const url = `${BRIDGE_URL}/sessions/${sessionId}${urlPath}`;
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${BRIDGE_TOKEN}`);
  const isFormDataBody = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (!isFormDataBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...options, headers });
}

async function extractError(response) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    return json.error || json.message || text;
  } catch {
    return text;
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const resolvedFilePath = path.resolve(parsed.filePath);
  const fileStats = await stat(resolvedFilePath);
  if (!fileStats.isFile()) {
    throw new Error("upload-media.js requires a path to a file");
  }

  const messageId = await readCurrentMessageId();
  const fileBytes = await readFile(resolvedFilePath);
  const mimeType = getMimeType(resolvedFilePath);

  if (!mimeType) {
    throw new Error("upload-media.js only supports .png, .jpg, .jpeg, and .webp files");
  }

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([fileBytes], { type: mimeType }),
    path.basename(resolvedFilePath)
  );
  formData.append("artifactType", "screenshot");
  formData.append("messageId", messageId);

  if (parsed.caption) formData.append("caption", parsed.caption);
  if (parsed.sourceUrl) formData.append("sourceUrl", parsed.sourceUrl);
  if (parsed.fullPage) formData.append("fullPage", "true");
  if (parsed.annotated) formData.append("annotated", "true");
  if (parsed.viewport) formData.append("viewport", parsed.viewport);

  const response = await bridgeFetch("/media", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await extractError(response));
  }

  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(args) {
  if (args.length === 0 || args.includes("--help")) {
    printUsageAndExit(0);
  }

  const filePath = args[0];
  const options = {
    filePath,
    caption: undefined,
    sourceUrl: undefined,
    fullPage: false,
    annotated: false,
    viewport: undefined,
  };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--caption":
        options.caption = requireValue(args, ++index, "--caption");
        break;
      case "--source-url":
        options.sourceUrl = requireValue(args, ++index, "--source-url");
        break;
      case "--full-page":
        options.fullPage = true;
        break;
      case "--annotated":
        options.annotated = true;
        break;
      case "--viewport":
        options.viewport = requireValue(args, ++index, "--viewport");
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(args, index, flagName) {
  const value = args[index];
  if (!value) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

async function readCurrentMessageId() {
  try {
    const value = (await readFile(CURRENT_MESSAGE_ID_FILE, "utf8")).trim();
    if (!value) {
      throw new Error("empty file");
    }
    return value;
  } catch {
    throw new Error(
      "No active prompt messageId found. upload-media.js can only run while a prompt is executing."
    );
  }
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

function printUsageAndExit(exitCode) {
  const usage = `
Usage:
  upload-media <file-path> [--caption "..."] [--source-url "..."] [--full-page] [--annotated] [--viewport '{"width":1280,"height":720}']
`;
  if (exitCode === 0) {
    console.log(usage.trim());
  } else {
    console.error(usage.trim());
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
