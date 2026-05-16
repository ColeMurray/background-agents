#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_DURATION_MS = 90_000;
const DEFAULT_FPS = 12;
const DEFAULT_FRAME_DURATION_SECONDS = 1 / DEFAULT_FPS;
const MIN_FRAME_DURATION_SECONDS = 0.001;

function parseArgs(args) {
  const options = {
    output: undefined,
    metadata: undefined,
    dimensions: undefined,
    maxDurationMs: DEFAULT_MAX_DURATION_MS,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--output":
        options.output = requireValue(args, ++index, "--output");
        break;
      case "--metadata":
        options.metadata = requireValue(args, ++index, "--metadata");
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

  if (!options.output) {
    throw new Error("--output requires a value");
  }
  if (!options.metadata) {
    throw new Error("--metadata requires a value");
  }
  if (!Number.isFinite(options.maxDurationMs) || options.maxDurationMs <= 0) {
    throw new Error("--max-duration-ms must be a positive number");
  }
  if (options.maxDurationMs > DEFAULT_MAX_DURATION_MS) {
    throw new Error(`--max-duration-ms must be ${DEFAULT_MAX_DURATION_MS} or less`);
  }
  return {
    output: path.resolve(options.output),
    metadata: path.resolve(options.metadata),
    dimensions: options.dimensions,
    maxDurationMs: Math.round(options.maxDurationMs),
  };
}

function parseDimensions(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--dimensions must be valid JSON");
  }

  const dimensions = extractDimensions(parsed);
  if (!dimensions) {
    throw new Error("--dimensions must include positive integer width and height");
  }
  return dimensions;
}

function requireValue(args, index, flagName) {
  const value = args[index];
  if (!value) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Set();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener(
        "error",
        () => reject(new Error(`Unable to connect to Chrome DevTools at ${this.url}`)),
        { once: true }
      );
    });

    this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
    this.ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  handleMessage(rawData) {
    const messageText = typeof rawData === "string" ? rawData : rawData.toString();
    const message = JSON.parse(messageText);

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "Chrome DevTools command failed"));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    for (const handler of this.eventHandlers) {
      handler(message);
    }
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  command(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}

async function getCdpWebSocketUrl() {
  if (process.env.AGENT_BROWSER_CDP_URL) {
    return normalizeCdpUrl(process.env.AGENT_BROWSER_CDP_URL);
  }

  const output = await execFileText("agent-browser", ["get", "cdp-url"]);
  return normalizeCdpUrl(parseCdpUrl(output));
}

function parseCdpUrl(output) {
  const trimmed = output.trim();
  try {
    const parsed = JSON.parse(trimmed);
    const found = findUrlInJson(parsed);
    if (found) return found;
  } catch {
    // Fall through to regex parsing for plain-text CLI output.
  }

  const match = trimmed.match(/(wss?:\/\/[^\s"'`]+|https?:\/\/[^\s"'`]+)/);
  if (!match) {
    throw new Error("agent-browser did not return a Chrome DevTools URL");
  }
  return match[1];
}

function findUrlInJson(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUrlInJson(item);
      if (found) return found;
    }
    return null;
  }

  for (const key of ["webSocketDebuggerUrl", "cdpUrl", "cdpURL", "url", "endpoint"]) {
    if (typeof value[key] === "string") return value[key];
  }
  for (const nested of Object.values(value)) {
    const found = findUrlInJson(nested);
    if (found) return found;
  }
  return null;
}

async function normalizeCdpUrl(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new Error("Chrome DevTools URL must use ws, wss, http, or https");
  }

  const base = trimmed.endsWith("/json/version")
    ? trimmed
    : `${trimmed.replace(/\/$/, "")}/json/version`;
  const response = await fetch(base);
  if (!response.ok) {
    throw new Error(`Unable to resolve Chrome DevTools websocket: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (typeof payload.webSocketDebuggerUrl !== "string") {
    throw new Error("Chrome DevTools version response did not include a websocket URL");
  }
  return payload.webSocketDebuggerUrl;
}

async function attachToPage(client) {
  try {
    const targets = await client.command("Target.getTargets");
    const targetInfos = Array.isArray(targets.targetInfos) ? targets.targetInfos : [];
    const pages = targetInfos.filter((target) => target.type === "page");
    const preferred =
      pages.findLast?.((target) => target.url && target.url !== "about:blank") ??
      [...pages].reverse().find((target) => target.url && target.url !== "about:blank") ??
      pages.at(-1);

    if (!preferred?.targetId) {
      return undefined;
    }

    const attached = await client.command("Target.attachToTarget", {
      targetId: preferred.targetId,
      flatten: true,
    });
    return attached.sessionId;
  } catch {
    return undefined;
  }
}

async function recordBrowserVideo(options) {
  const cdpUrl = await getCdpWebSocketUrl();
  const framesDir = await mkdtemp(path.join(os.tmpdir(), "openinspect-video-frames-"));
  const client = new CdpClient(cdpUrl);
  const frameWrites = [];
  const frames = [];
  let frameCount = 0;
  let dimensions = options.dimensions ?? null;
  let frameError = null;
  let truncated = false;
  let stopRequested = false;

  const recordingStartedAt = Date.now();

  const requestStop = (wasTruncated) => {
    truncated = truncated || wasTruncated;
    stopRequested = true;
  };

  process.once("SIGTERM", () => requestStop(false));
  process.once("SIGINT", () => requestStop(false));

  const maxDurationTimer = setTimeout(() => requestStop(true), options.maxDurationMs);

  try {
    await client.connect();
    const sessionId = await attachToPage(client);

    client.onEvent((message) => {
      const isCurrentSession = !sessionId || message.sessionId === sessionId;
      if (message.method !== "Page.screencastFrame" || !isCurrentSession) {
        return;
      }

      const params = message.params || {};
      const frameMetadata = params.metadata || {};
      const frameBytes = Buffer.from(params.data, "base64");
      const capturedAt = Date.now();
      dimensions =
        dimensions ?? extractDimensions(frameMetadata) ?? extractJpegDimensions(frameBytes);

      frameCount += 1;
      const framePath = path.join(framesDir, `frame-${String(frameCount).padStart(6, "0")}.jpg`);
      frames.push({ path: framePath, capturedAt });
      const writePromise = writeFile(framePath, frameBytes).catch((error) => {
        frameError = error;
        requestStop(false);
      });
      frameWrites.push(writePromise);
      void client
        .command("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId)
        .catch(() => {});
    });

    await client.command("Page.enable", {}, sessionId);
    await client.command(
      "Page.startScreencast",
      {
        format: "jpeg",
        quality: 80,
        everyNthFrame: 1,
      },
      sessionId
    );

    while (!stopRequested) {
      await sleep(100);
    }

    await client.command("Page.stopScreencast", {}, sessionId).catch(() => {});
    await Promise.all(frameWrites);
    if (frameError) throw frameError;
    if (frameCount === 0) {
      throw new Error("No browser frames were captured");
    }
    if (!dimensions) {
      throw new Error("Unable to determine recording dimensions");
    }

    const recordingEndedAt = Date.now();
    await mkdir(path.dirname(options.output), { recursive: true });
    await encodeFrames(frames, options.output);

    return {
      durationMs: Math.max(1, recordingEndedAt - recordingStartedAt),
      recordingStartedAt,
      recordingEndedAt,
      dimensions,
      truncated,
      hasAudio: false,
    };
  } finally {
    clearTimeout(maxDurationTimer);
    client.close();
    await rm(framesDir, { recursive: true, force: true });
  }
}

function extractDimensions(frameMetadata) {
  const width = frameMetadata.deviceWidth ?? frameMetadata.width;
  const height = frameMetadata.deviceHeight ?? frameMetadata.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function extractJpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame && offset + 8 < bytes.length) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }

    if (length < 2) return null;
    offset += 2 + length;
  }

  return null;
}

async function encodeFrames(frames, outputPath) {
  const concatPath = path.join(os.tmpdir(), `openinspect-video-${process.pid}.ffconcat`);
  await writeFile(concatPath, buildConcatManifest(frames), "utf8");

  try {
    await execFileText("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatPath,
      "-an",
      "-vsync",
      "vfr",
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
  } finally {
    await rm(concatPath, { force: true });
  }
}

function buildConcatManifest(frames) {
  const lines = ["ffconcat version 1.0"];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const nextFrame = frames[index + 1];
    const durationSeconds = nextFrame
      ? Math.max((nextFrame.capturedAt - frame.capturedAt) / 1000, MIN_FRAME_DURATION_SECONDS)
      : DEFAULT_FRAME_DURATION_SECONDS;

    lines.push(`file ${quoteConcatPath(frame.path)}`);
    lines.push(`duration ${durationSeconds.toFixed(6)}`);
  }

  const lastFrame = frames[frames.length - 1];
  if (lastFrame) {
    lines.push(`file ${quoteConcatPath(lastFrame.path)}`);
  }

  return `${lines.join("\n")}\n`;
}

function quoteConcatPath(filePath) {
  return `'${filePath.replace(/'/g, "'\\''")}'`;
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const metadata = await recordBrowserVideo(options);
  await mkdir(path.dirname(options.metadata), { recursive: true });
  await writeFile(options.metadata, JSON.stringify(metadata, null, 2));
}

function printUsageAndExit(exitCode) {
  const usage = `
Usage:
  browser-video-recorder --output /tmp/recording.mp4 --metadata /tmp/recording.mp4.json [--dimensions '{"width":1280,"height":720}'] [--max-duration-ms 90000]
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
