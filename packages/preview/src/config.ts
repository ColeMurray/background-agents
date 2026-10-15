import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { EnvConfig } from "@open-inspect/control-plane/src/types";
import type { TeamsMode } from "./ready";

export const PREVIEW_LIFETIME_MS = 4 * 60 * 60 * 1000;
const PREVIEW_REQUEST_TIMEOUT_MS = 10_000;
export const randomSecret = () => randomBytes(32).toString("base64");

/** One request's deadline, ended early if the caller stops the preview. */
export function previewRequestSignal(
  signal?: AbortSignal,
  timeoutMs = PREVIEW_REQUEST_TIMEOUT_MS
): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([deadline, signal]) : deadline;
}

export function previewConfig(options: {
  webOrigin: string;
  controlPlaneOrigin: string;
  modalOrigin: string;
  modalSecret: string;
  teamsEnforcement: TeamsMode;
}): EnvConfig {
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
    WEB_APP_URL: options.webOrigin,
    WORKER_URL: options.controlPlaneOrigin,
    ALLOWED_EMAIL_DOMAINS: "preview.test",
    GITHUB_CLIENT_ID: "preview-client",
    GITHUB_CLIENT_SECRET: "preview-client-secret",
    GITHUB_APP_ID: String(randomBytes(6).readUIntBE(0, 6)),
    GITHUB_APP_INSTALLATION_ID: "90001",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    SANDBOX_PROVIDER: "modal",
    MODAL_WORKSPACE: "preview",
    MODAL_API_URL: options.modalOrigin,
    MODAL_API_SECRET: options.modalSecret,
    TEAMS_ENFORCEMENT: options.teamsEnforcement,
    // Never used against a model service; lets the existing fallback resolve the default model.
    ANTHROPIC_API_KEY: "preview-inert-anthropic-key",
    LOG_LEVEL: "warn",
  };
}

/** Only what a child process needs to find its tools; nothing of the caller's credentials. */
export function toolEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot"]) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  return env;
}
