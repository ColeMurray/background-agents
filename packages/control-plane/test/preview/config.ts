import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ENV_CONFIG_KEY_NAMES } from "../../src/node/config";
import type { EnvConfig } from "../../src/types";

export const PREVIEW_LIFETIME_MS = 4 * 60 * 60 * 1000;
export const PREVIEW_REQUEST_TIMEOUT_MS = 10_000;
export { PREVIEW_REPLY } from "./contracts";
export const randomSecret = () => randomBytes(32).toString("base64");

export function previewConfig(
  webOrigin: string,
  controlPlaneOrigin: string,
  modalOrigin: string,
  modalSecret: string
): EnvConfig {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    DEPLOYMENT_NAME: "authenticated-preview",
    APP_NAME: "OpenInspect Preview",
    GITHUB_BOT_USERNAME: "preview-bot[bot]",
    SCM_PROVIDER: "github",
    TOKEN_ENCRYPTION_KEY: randomSecret(),
    PROVIDER_ACCOUNTS_ENCRYPTION_KEY: randomSecret(),
    REPO_SECRETS_ENCRYPTION_KEY: randomSecret(),
    BROWSER_AUTH_SECRET: randomSecret(),
    SERVICE_AUTH_SECRET_WEB: randomSecret(),
    WEB_APP_URL: webOrigin,
    WORKER_URL: controlPlaneOrigin,
    ALLOWED_EMAIL_DOMAINS: "preview.test",
    GITHUB_CLIENT_ID: "preview-client",
    GITHUB_CLIENT_SECRET: "preview-client-secret",
    GITHUB_APP_ID: String(randomBytes(6).readUIntBE(0, 6)),
    GITHUB_APP_INSTALLATION_ID: "90001",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    SANDBOX_PROVIDER: "modal",
    MODAL_WORKSPACE: "preview",
    MODAL_API_URL: modalOrigin,
    MODAL_API_SECRET: modalSecret,
    // Never used against a model service; lets the existing fallback resolve the default model.
    ANTHROPIC_API_KEY: "preview-inert-anthropic-key",
    LOG_LEVEL: "warn",
  };
}

export function toolEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot"]) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  return env;
}

// dotenv's key grammar, which Next's bundled loader uses; a few extra matches only blank more.
const DOTENV_KEY = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=|:\s)/gm;

/**
 * Every key named in the web package's `.env` and `.env.*` files, whichever of them Next would
 * load. Next reads them into its server process, so the preview must account for each one.
 */
export async function webEnvFileKeys(webDir: string): Promise<string[]> {
  const keys = new Set<string>();
  for (const name of await readdir(webDir)) {
    if (name !== ".env" && !name.startsWith(".env.")) continue;
    // Next follows symbolic links and skips missing targets, so the preview does the same.
    const stats = await stat(join(webDir, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    // Next also reads FIFOs, which cannot be inspected without consuming what Next would read.
    if (stats?.isFIFO())
      throw new Error(
        `preflight: packages/web/${name} is a FIFO whose keys the preview cannot blank; move it aside first.`
      );
    if (!stats?.isFile()) continue;
    const contents = await readFile(join(webDir, name), "utf8");
    for (const [, key] of contents.matchAll(DOTENV_KEY)) keys.add(key);
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
