import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { parse } from "dotenv";
import { ENV_CONFIG_KEY_NAMES } from "@open-inspect/control-plane/src/node/config";
import type { EnvConfig } from "@open-inspect/control-plane/src/types";
import { toolEnvironment } from "./config";
import { stopChildGroup } from "./process";

/** The files `next dev` loads (see @next/env), parsed with the dotenv grammar Next bundles. */
const NEXT_DEV_ENV_FILES = [".env.development.local", ".env.local", ".env.development", ".env"];

/** Every key the web package's development .env files name; Next would read each into its server. */
export async function webEnvFileKeys(webDir: string): Promise<string[]> {
  const keys = new Set<string>();
  for (const name of NEXT_DEV_ENV_FILES) {
    const path = join(webDir, name);
    // Follows symbolic links as Next does, and skips a missing file or dangling link as Next does.
    const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats) continue;
    if (!stats.isFile())
      throw new Error(
        `preflight: packages/web/${name} is not a regular file; move it aside first.`
      );
    for (const key of Object.keys(parse(await readFile(path)))) keys.add(key);
  }
  return [...keys];
}

/**
 * Explicit empty values take precedence over Next's .env files: every key those files name is
 * blanked, then only what the preview passes deliberately is set.
 */
export function webEnvironment(
  parent: NodeJS.ProcessEnv,
  config: EnvConfig,
  envFileKeys: readonly string[]
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(envFileKeys.map((key) => [key, ""])),
    ...toolEnvironment(parent),
    ...Object.fromEntries(ENV_CONFIG_KEY_NAMES.map((key) => [key, ""])),
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    VERCEL: "",
    VERCEL_URL: "",
    VERCEL_ENV: "",
    CONTROL_PLANE_URL: config.WORKER_URL!,
    SERVICE_AUTH_SECRET: config.SERVICE_AUTH_SECRET_WEB!,
    NEXT_PUBLIC_WS_URL: config.WORKER_URL!.replace(/^http/, "ws"),
    NEXT_PUBLIC_APP_NAME: "OpenInspect Preview",
    NEXT_PUBLIC_APP_ICON_URL: "",
    NEXT_PUBLIC_SCM_PROVIDER: "github",
    NEXT_PUBLIC_SANDBOX_PROVIDER: "modal",
    SANDBOX_PROVIDER: "modal",
    LOG_LEVEL: "error",
  };
}

interface NextServer {
  /** Why Next stopped serving, once it has exited or failed to start. */
  readonly failure: Error | undefined;
  /** Settles when Next exits or its process/log fails. */
  readonly exited: Promise<void>;
  stop(): Promise<void>;
}

/** The web package's own `next dev`, logging to `logPath`. Never attaches to another server. */
export function startNext(options: {
  root: string;
  port: number;
  env: NodeJS.ProcessEnv;
  logPath: string;
}): NextServer {
  const log = createWriteStream(options.logPath, { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      join(options.root, "node_modules/next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(options.port),
    ],
    {
      cwd: join(options.root, "packages/web"),
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  // Both streams share the log, so neither may end it; stop() does.
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  let failure: Error | undefined;
  const exited = new Promise<void>((resolve) => {
    child.on("error", (error) => {
      failure ??= error;
      resolve();
    });
    log.on("error", (error) => {
      failure ??= new Error(`web: Next log failed: ${error.message}`, { cause: error });
      resolve();
    });
    child.once("exit", (code, signal) => {
      failure ??= new Error(`web: Next exited (${signal ?? code}); inspect ${options.logPath}`);
      resolve();
    });
  });
  // Observe errors immediately; the failure above is reported through the stack, not an unhandled
  // stream rejection. A failed stream may already be closed by the time cleanup starts.
  const logClosed = finished(log).catch(() => {});
  return {
    get failure() {
      return failure;
    },
    exited,
    async stop() {
      try {
        await stopChildGroup(child);
      } finally {
        child.stdout!.unpipe(log);
        child.stderr!.unpipe(log);
        log.end();
        await logClosed;
      }
    },
  };
}
