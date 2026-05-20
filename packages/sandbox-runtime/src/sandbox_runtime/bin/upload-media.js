#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const BRIDGE_URL = process.env.CONTROL_PLANE_URL || "http://localhost:8787";
const BRIDGE_TOKEN = process.env.SANDBOX_AUTH_TOKEN;

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

  const fileBytes = await readFile(resolvedFilePath);
  const mimeType = getMimeType(resolvedFilePath);

  if (!mimeType) {
    throw new Error("upload-media.js only supports .png, .jpg, .jpeg, .webp, and .mp4 files");
  }

  const artifactType = parsed.artifactType ?? "screenshot";
  if (mimeType === "video/mp4" && artifactType !== "video") {
    throw new Error("MP4 files must be uploaded with --artifact-type video");
  }
  if (artifactType === "video") {
    validateVideoOptions(parsed);
  }

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([fileBytes], { type: mimeType }),
    path.basename(resolvedFilePath)
  );
  formData.append("artifactType", artifactType);

  if (artifactType === "video") {
    formData.append("caption", parsed.caption);
    formData.append("durationMs", parsed.durationMs);
    formData.append("recordingStartedAt", parsed.recordingStartedAt);
    formData.append("recordingEndedAt", parsed.recordingEndedAt);
    formData.append("dimensions", parsed.dimensions);
    formData.append("truncated", parsed.truncated);
    formData.append("hasAudio", parsed.hasAudio ?? "false");
    if (parsed.sourceUrl) formData.append("sourceUrl", parsed.sourceUrl);
    if (parsed.endUrl) formData.append("endUrl", parsed.endUrl);
  } else {
    if (parsed.caption) formData.append("caption", parsed.caption);
    if (parsed.sourceUrl) formData.append("sourceUrl", parsed.sourceUrl);
    if (parsed.fullPage) formData.append("fullPage", "true");
    if (parsed.annotated) formData.append("annotated", "true");
    if (parsed.viewport) formData.append("viewport", parsed.viewport);
  }

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
    artifactType: undefined,
    caption: undefined,
    sourceUrl: undefined,
    endUrl: undefined,
    fullPage: false,
    annotated: false,
    viewport: undefined,
    durationMs: undefined,
    recordingStartedAt: undefined,
    recordingEndedAt: undefined,
    dimensions: undefined,
    truncated: undefined,
    hasAudio: undefined,
  };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--artifact-type":
        options.artifactType = parseArtifactType(requireValue(args, ++index, "--artifact-type"));
        break;
      case "--caption":
        options.caption = requireValue(args, ++index, "--caption");
        break;
      case "--source-url":
        options.sourceUrl = requireValue(args, ++index, "--source-url");
        break;
      case "--end-url":
        options.endUrl = requireValue(args, ++index, "--end-url");
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
      case "--duration-ms":
        options.durationMs = requireValue(args, ++index, "--duration-ms");
        break;
      case "--recording-started-at":
        options.recordingStartedAt = requireValue(args, ++index, "--recording-started-at");
        break;
      case "--recording-ended-at":
        options.recordingEndedAt = requireValue(args, ++index, "--recording-ended-at");
        break;
      case "--dimensions":
        options.dimensions = requireValue(args, ++index, "--dimensions");
        break;
      case "--truncated":
        options.truncated = requireValue(args, ++index, "--truncated");
        break;
      case "--has-audio":
        options.hasAudio = requireValue(args, ++index, "--has-audio");
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseArtifactType(value) {
  if (value === "screenshot" || value === "video") {
    return value;
  }
  throw new Error("--artifact-type must be screenshot or video");
}

function requireValue(args, index, flagName) {
  const value = args[index];
  if (!value) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

function validateVideoOptions(options) {
  requireVideoValue(options.caption, "--caption");
  requireVideoValue(options.durationMs, "--duration-ms");
  requireVideoValue(options.recordingStartedAt, "--recording-started-at");
  requireVideoValue(options.recordingEndedAt, "--recording-ended-at");
  requireVideoValue(options.dimensions, "--dimensions");
  requireVideoValue(options.truncated, "--truncated");
}

function requireVideoValue(value, flagName) {
  if (!value) {
    throw new Error(`${flagName} requires a value for video uploads`);
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
    case ".mp4":
      return "video/mp4";
    default:
      return null;
  }
}

function printUsageAndExit(exitCode) {
  const usage = `
Usage:
  upload-media <file-path> [--caption "..."] [--source-url "..."] [--full-page] [--annotated] [--viewport '{"width":1280,"height":720}']
  upload-media <recording.mp4> --artifact-type video --caption "..." --duration-ms <ms> --recording-started-at <epoch-ms> --recording-ended-at <epoch-ms> --dimensions '{"width":1280,"height":720}' --truncated false
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
