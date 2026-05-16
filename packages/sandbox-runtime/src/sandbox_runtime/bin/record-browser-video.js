#!/usr/bin/env node

import { mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(args) {
  const separatorIndex = args.indexOf("--");
  const optionArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  const interactionCommand = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);
  const options = {
    url: undefined,
    caption: undefined,
    outputBasename: undefined,
    viewport: undefined,
  };

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    switch (arg) {
      case "--url":
        options.url = requireValue(optionArgs, ++index, "--url");
        break;
      case "--caption":
        options.caption = requireValue(optionArgs, ++index, "--caption");
        break;
      case "--output-basename":
        options.outputBasename = requireValue(optionArgs, ++index, "--output-basename");
        break;
      case "--viewport":
        options.viewport = parseViewport(requireValue(optionArgs, ++index, "--viewport"));
        break;
      case "--help":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.url || !options.url.trim()) {
    throw new Error("--url requires a value");
  }
  if (!options.caption || !options.caption.trim()) {
    throw new Error("--caption requires a value");
  }
  if (!options.outputBasename || !options.outputBasename.trim()) {
    throw new Error("--output-basename requires a value");
  }

  return {
    ...options,
    url: options.url.trim(),
    caption: options.caption.trim(),
    outputBasename: normalizeOutputBasename(options.outputBasename.trim()),
    interactionCommand,
  };
}

function requireValue(args, index, flagName) {
  const value = args[index];
  if (!value) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

function parseViewport(value) {
  const trimmed = value.trim();
  const sizeMatch = trimmed.match(/^(\d+)x(\d+)$/);
  if (sizeMatch) {
    return parseViewportDimensions(Number(sizeMatch[1]), Number(sizeMatch[2]));
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("--viewport must be WIDTHxHEIGHT or valid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("--viewport must include positive integer width and height");
  }

  return parseViewportDimensions(parsed.width, parsed.height);
}

function parseViewportDimensions(width, height) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("--viewport must include positive integer width and height");
  }
  return { width, height };
}

function normalizeOutputBasename(value) {
  const resolved = path.resolve(value);
  if (resolved.endsWith(".mp4")) return resolved.slice(0, -".mp4".length);
  return resolved;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mp4Path = `${options.outputBasename}.mp4`;
  await mkdir(path.dirname(mp4Path), { recursive: true });

  let recordingStarted = false;
  let recordingStartedAt = 0;
  let recordingEndedAt = 0;
  let interactionError = null;
  let stopError = null;

  try {
    await execFile("agent-browser", ["open", options.url]);
    if (options.viewport) {
      await execFile("agent-browser", [
        "set",
        "viewport",
        String(options.viewport.width),
        String(options.viewport.height),
      ]);
    }

    await execFile("agent-browser", ["record", "start", mp4Path]);
    recordingStarted = true;
    recordingStartedAt = Date.now();

    if (options.interactionCommand.length > 0) {
      try {
        await execFile(options.interactionCommand[0], options.interactionCommand.slice(1), {
          env: process.env,
          stdio: "inherit",
        });
      } catch (error) {
        interactionError = error;
      }
    }
  } finally {
    if (recordingStarted) {
      try {
        await stopAgentBrowserRecording();
      } catch (error) {
        stopError = error;
      }
      recordingEndedAt = Date.now();
    }
  }

  await assertFile(
    mp4Path,
    stopError
      ? `agent-browser record stop failed and no MP4 recording was produced: ${errorMessage(stopError)}`
      : "agent-browser did not produce an MP4 recording"
  );
  const metadata = await probeMp4(mp4Path);
  const uploadOutput = await uploadMp4({
    mp4Path,
    caption: options.caption,
    sourceUrl: options.url,
    durationMs: metadata.durationMs,
    recordingStartedAt,
    recordingEndedAt,
    dimensions: metadata.dimensions,
  });

  process.stdout.write(uploadOutput);

  if (interactionError) {
    console.error(formatPostUploadWarning("interaction command failed", interactionError));
    process.exitCode = 1;
  }
  if (stopError) {
    console.error(formatPostUploadWarning("agent-browser record stop failed", stopError));
    process.exitCode = 1;
  }
}

async function stopAgentBrowserRecording() {
  try {
    await execFile("agent-browser", ["record", "stop"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`agent-browser record stop failed: ${message}`);
  }
}

function formatPostUploadWarning(prefix, error) {
  return `${prefix} after recording started; uploaded any available recording. ${errorMessage(error)}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function assertFile(filePath, message) {
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile() || fileStats.size <= 0) {
      throw new Error(message);
    }
  } catch (error) {
    if (error instanceof Error && error.message === message) {
      throw error;
    }
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(message);
    }
    throw error;
  }
}

async function probeMp4(mp4Path) {
  const output = await execFile("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    mp4Path,
  ]);

  let data;
  try {
    data = JSON.parse(output);
  } catch {
    throw new Error("ffprobe did not return valid JSON");
  }

  const videoStream = Array.isArray(data.streams)
    ? data.streams.find((stream) => stream.codec_type === "video")
    : null;
  const width = Number(videoStream?.width);
  const height = Number(videoStream?.height);
  const durationSeconds = Number(videoStream?.duration ?? data.format?.duration);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("ffprobe did not report valid video dimensions");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("ffprobe did not report a valid video duration");
  }

  return {
    dimensions: { width, height },
    durationMs: Math.max(1, Math.round(durationSeconds * 1000)),
  };
}

async function uploadMp4(input) {
  const uploadScript = await resolveSiblingScript("upload-media");
  return execFile(process.execPath, [
    uploadScript,
    input.mp4Path,
    "--artifact-type",
    "video",
    "--caption",
    input.caption,
    "--source-url",
    input.sourceUrl,
    "--duration-ms",
    String(input.durationMs),
    "--recording-started-at",
    String(input.recordingStartedAt),
    "--recording-ended-at",
    String(input.recordingEndedAt),
    "--dimensions",
    JSON.stringify(input.dimensions),
    "--truncated",
    "false",
    "--has-audio",
    "false",
  ]);
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

function execFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", (error) => {
      reject(new Error(`${command} failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
      }
    });
  });
}

function printUsageAndExit(exitCode) {
  const usage = `
Usage:
  record-browser-video --url URL --caption "What this verifies" --output-basename /tmp/opencode/demo [--viewport 1512x982] -- bash -lc 'agent-browser click "[data-testid=save]" && agent-browser wait 1000'

Records MP4 directly with agent-browser record, probes actual MP4 metadata with ffprobe, uploads with upload-media, and prints the upload JSON.
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
