#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const BRIDGE_URL = process.env.CONTROL_PLANE_URL || "http://localhost:8787";
const BRIDGE_TOKEN = process.env.SANDBOX_AUTH_TOKEN;

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
  if (!BRIDGE_TOKEN) {
    throw new Error("SANDBOX_AUTH_TOKEN not set");
  }

  const resolvedFilePath = path.resolve(parsed.filePath);
  const fileStats = await stat(resolvedFilePath);
  if (!fileStats.isFile()) {
    throw new Error("upload-file requires a path to a file");
  }

  const fileBytes = await readFile(resolvedFilePath);
  const mimeType = getMimeType(resolvedFilePath);
  if (!mimeType) {
    throw new Error("upload-file does not support this file extension");
  }

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([fileBytes], { type: mimeType }),
    path.basename(resolvedFilePath)
  );
  if (parsed.caption) formData.append("caption", parsed.caption);

  const response = await bridgeFetch("/files", {
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

  const options = {
    filePath: args[0],
    caption: undefined,
  };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--caption":
        options.caption = requireValue(args, ++index, "--caption");
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

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".csv":
      return "text/csv";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".txt":
      return "text/plain";
    case ".webp":
      return "image/webp";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".zip":
      return "application/zip";
    default:
      return null;
  }
}

function printUsageAndExit(exitCode) {
  const usage = `
Usage:
  upload-file <file-path> [--caption "..."]

Supported extensions:
  .zip, .pptx, .docx, .xlsx, .pdf, .md, .txt, .csv, .json, .png, .jpg, .jpeg, .webp
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
