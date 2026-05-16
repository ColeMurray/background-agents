#!/usr/bin/env node

import { readFile, stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_PATH =
  process.env.OPEN_INSPECT_RECORDING_STATE ||
  path.join(os.tmpdir(), "openinspect-browser-video-state.json");
const DEFAULT_WAIT_MS = 30_000;

function parseArgs(args) {
  const options = {
    waitMs: DEFAULT_WAIT_MS,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--wait-ms":
        options.waitMs = Number(requireValue(args, ++index, "--wait-ms"));
        break;
      case "--help":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.waitMs) || options.waitMs <= 0) {
    throw new Error("--wait-ms must be a positive number");
  }

  return { waitMs: Math.round(options.waitMs) };
}

function requireValue(args, index, flagName) {
  const value = args[index];
  if (!value) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

async function readState() {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (!state?.recordingId) {
      throw new Error("No active browser recording found");
    }
    return state;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("No active browser recording found");
    }
    throw error;
  }
}

function signalRecorder(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
}

async function waitForRecording(state, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    const videoExists = await fileExists(state.videoPath);
    const metadataExists = await fileExists(state.metadataPath);
    if (videoExists && metadataExists) {
      await stat(state.videoPath);
      return;
    }
    await sleep(250);
  }

  throw new Error("Recording did not finish before the stop timeout");
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    const fileStats = await stat(filePath);
    return fileStats.isFile();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadRecording(state, metadata) {
  const uploadScript = await resolveSiblingScript("upload-media");
  const dimensions = state.dimensions ?? metadata.dimensions;
  if (!dimensions) {
    throw new Error("Recording metadata is missing dimensions");
  }
  const args = [
    uploadScript,
    state.videoPath,
    "--artifact-type",
    "video",
    "--caption",
    state.caption,
    "--duration-ms",
    String(metadata.durationMs),
    "--recording-started-at",
    String(metadata.recordingStartedAt),
    "--recording-ended-at",
    String(metadata.recordingEndedAt),
    "--dimensions",
    JSON.stringify(dimensions),
    "--truncated",
    String(Boolean(metadata.truncated)),
    "--has-audio",
    "false",
  ];

  if (state.sourceUrl) {
    args.push("--source-url", state.sourceUrl);
  }
  if (metadata.endUrl) {
    args.push("--end-url", metadata.endUrl);
  }

  return execNode(args);
}

async function resolveSiblingScript(stem) {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(currentDir, `${stem}.js`), path.join(currentDir, stem)];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return candidates[1];
}

function execNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `upload-media exited with status ${code}`));
      }
    });
  });
}

async function removeState() {
  try {
    await unlink(STATE_PATH);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const state = await readState();

  try {
    signalRecorder(state.recorderPid);
    await waitForRecording(state, options.waitMs);
    const metadata = JSON.parse(await readFile(state.metadataPath, "utf8"));
    const uploadOutput = await uploadRecording(state, metadata);
    await removeState();
    process.stdout.write(uploadOutput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}. Recording state preserved at ${STATE_PATH} for retry.`);
  }
}

function printUsageAndExit(exitCode) {
  const usage = `
Usage:
  stop-browser-video [--wait-ms 30000]
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
