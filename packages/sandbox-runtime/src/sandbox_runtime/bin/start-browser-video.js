#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_DURATION_MS = 90_000;
const STATE_PATH =
  process.env.OPEN_INSPECT_RECORDING_STATE ||
  path.join(os.tmpdir(), "openinspect-browser-video-state.json");

function parseArgs(args) {
  const options = {
    caption: undefined,
    sourceUrl: undefined,
    dimensions: undefined,
    maxDurationMs: DEFAULT_MAX_DURATION_MS,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--caption":
        options.caption = requireValue(args, ++index, "--caption");
        break;
      case "--source-url":
        options.sourceUrl = requireValue(args, ++index, "--source-url");
        break;
      case "--dimensions":
        options.dimensions = parseDimensions(requireValue(args, ++index, "--dimensions"));
        break;
      case "--max-duration-ms":
        options.maxDurationMs = Number(requireValue(args, ++index, "--max-duration-ms"));
        break;
      case "--help":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.caption || !options.caption.trim()) {
    throw new Error("--caption requires a value");
  }
  if (
    !Number.isFinite(options.maxDurationMs) ||
    options.maxDurationMs <= 0 ||
    options.maxDurationMs > DEFAULT_MAX_DURATION_MS
  ) {
    throw new Error(`--max-duration-ms must be between 1 and ${DEFAULT_MAX_DURATION_MS}`);
  }

  return {
    ...options,
    caption: options.caption.trim(),
    maxDurationMs: Math.round(options.maxDurationMs),
  };
}

function requireValue(args, index, flagName) {
  const value = args[index];
  if (!value) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

function parseDimensions(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--dimensions must be valid JSON");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Number.isInteger(parsed.width) ||
    parsed.width <= 0 ||
    !Number.isInteger(parsed.height) ||
    parsed.height <= 0
  ) {
    throw new Error("--dimensions must include positive integer width and height");
  }

  return { width: parsed.width, height: parsed.height };
}

async function assertNoActiveState() {
  try {
    const existing = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (existing?.recordingId) {
      throw new Error(`A browser recording is already active: ${existing.recordingId}`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function resolveSiblingScript(stem) {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(currentDir, `${stem}.js`), path.join(currentDir, stem)];
  for (const candidate of candidates) {
    try {
      const fileStats = await stat(candidate);
      if (fileStats.isFile()) return candidate;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return candidates[1];
}

async function startRecorderProcess(videoPath, metadataPath, maxDurationMs, dimensions) {
  const scriptPath = await resolveSiblingScript("browser-video-recorder");
  const args = [
    scriptPath,
    "--output",
    videoPath,
    "--metadata",
    metadataPath,
    "--max-duration-ms",
    String(maxDurationMs),
  ];
  if (dimensions) {
    args.push("--dimensions", JSON.stringify(dimensions));
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await assertNoActiveState();

  const recordingId = randomUUID();
  const startedAt = Date.now();
  const outputDir = path.join(os.tmpdir(), "openinspect-recordings");
  await mkdir(outputDir, { recursive: true });
  const videoPath = path.join(outputDir, `${recordingId}.mp4`);
  const metadataPath = `${videoPath}.json`;
  const recorderPid = await startRecorderProcess(
    videoPath,
    metadataPath,
    options.maxDurationMs,
    options.dimensions
  );

  const state = {
    recordingId,
    caption: options.caption,
    sourceUrl: options.sourceUrl,
    dimensions: options.dimensions,
    startedAt,
    maxDurationMs: options.maxDurationMs,
    videoPath,
    metadataPath,
    recorderPid,
  };
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));

  // Touch stat to surface permission/path failures before reporting success.
  await stat(STATE_PATH);
  console.log(JSON.stringify(state, null, 2));
}

function printUsageAndExit(exitCode) {
  const usage = `
Usage:
  start-browser-video --caption "What this recording verifies" [--source-url URL] [--dimensions '{"width":1280,"height":720}'] [--max-duration-ms 90000]
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
