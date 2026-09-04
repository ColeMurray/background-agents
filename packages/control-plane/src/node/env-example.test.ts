import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_CONFIG_KEY_NAMES } from "./config";

/** The repository's `.env.example`, the documented configuration of a Node host. */
const ENV_EXAMPLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../.env.example"
);

/** Variables the Node host reads that are not `EnvConfig` fields. */
const NODE_HOST_VARIABLES = [
  "HOST",
  "PORT",
  "DATA_DIR",
  "MIGRATIONS_DIR",
  "SHUTDOWN_TIMEOUT_MS",
  "OBJECT_STORE_BUCKET",
  "OBJECT_STORE_REGION",
  "OBJECT_STORE_ENDPOINT",
  "OBJECT_STORE_ALLOW_HTTP",
  "OBJECT_STORE_FORCE_PATH_STYLE",
  // Read by the AWS SDK's default credential chain, not by the host itself.
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];

function documentedVariables(): string[] {
  const names: string[] = [];
  for (const line of readFileSync(ENV_EXAMPLE_PATH, "utf8").split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

describe(".env.example", () => {
  it("names every EnvConfig field and every Node host variable, each once", () => {
    const documented = documentedVariables();
    const expected = [...ENV_CONFIG_KEY_NAMES, ...NODE_HOST_VARIABLES];
    expect([...documented].sort()).toEqual([...expected].sort());
  });
});
