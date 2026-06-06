#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { getRequiredEnvKeys, readRootEnv, requireEnv, root } from "./env-utils.mjs";

function shellWords(command) {
  return (
    command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => {
      if (
        (part.startsWith('"') && part.endsWith('"')) ||
        (part.startsWith("'") && part.endsWith("'"))
      ) {
        return part.slice(1, -1);
      }
      return part;
    }) ?? [command]
  );
}

function createSecret(modalCommand, secretName, values) {
  const [command, ...baseArgs] = modalCommand;
  const args = [
    ...baseArgs,
    "secret",
    "create",
    secretName,
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    "--force",
  ];

  console.log(`creating/updating Modal secret: ${secretName}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: root,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const env = readRootEnv();
const requiredEnvKeys = getRequiredEnvKeys(env);
requireEnv(env, requiredEnvKeys.modalSecrets);

if (requiredEnvKeys.modalSecrets.length === 0) {
  console.log("Modal secrets are not required for SANDBOX_PROVIDER=daytona.");
  process.exit(0);
}

let controlPlaneUrl;
try {
  controlPlaneUrl = new URL(env.CONTROL_PLANE_URL);
} catch {
  console.error(`Invalid CONTROL_PLANE_URL in .env.local: ${env.CONTROL_PLANE_URL}`);
  process.exit(1);
}

const allowedHosts = env.ALLOWED_CONTROL_PLANE_HOSTS || controlPlaneUrl.host;
const modalCommand = shellWords(process.env.MODAL_CLI || "modal");

createSecret(modalCommand, "llm-api-keys", {
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
});

createSecret(modalCommand, "github-app", {
  GITHUB_APP_ID: env.GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
  GITHUB_APP_INSTALLATION_ID: env.GITHUB_APP_INSTALLATION_ID,
});

createSecret(modalCommand, "internal-api", {
  MODAL_API_SECRET: env.MODAL_API_SECRET,
  INTERNAL_CALLBACK_SECRET: env.INTERNAL_CALLBACK_SECRET,
  ALLOWED_CONTROL_PLANE_HOSTS: allowedHosts,
  CONTROL_PLANE_URL: env.CONTROL_PLANE_URL,
});

console.log("Modal secrets are up to date.");
