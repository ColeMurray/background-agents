import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENV_CONFIG_KEY_NAMES,
  NODE_HOST_VARIABLE_NAMES,
  REQUIRED_ENV_CONFIG_KEY_NAMES,
} from "./config";
import { AWS_CREDENTIAL_VARIABLE_NAMES, OBJECT_STORAGE_VARIABLE_NAMES } from "./s3-object-storage";

/** The repository's `.env.example`, the documented configuration of a Node host. */
const ENV_EXAMPLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../.env.example"
);

/** Variables docker-compose.yml and its sidecars read; the host never sees them. */
const COMPOSE_VARIABLES = [
  "APP_BIND_ADDRESS",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "LITESTREAM_BUCKET",
  "LITESTREAM_ENDPOINT",
  "LITESTREAM_ACCESS_KEY_ID",
  "LITESTREAM_SECRET_ACCESS_KEY",
  "CADDY_DOMAIN",
];

/** A key's comment block opens with this when a boot cannot do without the key. */
const REQUIRED_MARKER = "# Required.";

interface DocumentedVariable {
  name: string;
  /** The comment lines directly above the assignment, up to the previous blank line. */
  comment: string[];
}

interface EnvExample {
  variables: DocumentedVariable[];
  /** Lines that are neither blank, a comment, nor a `NAME=value` assignment. */
  malformed: string[];
}

function parseEnvExample(): EnvExample {
  const variables: DocumentedVariable[] = [];
  const malformed: string[] = [];
  let comment: string[] = [];
  for (const line of readFileSync(ENV_EXAMPLE_PATH, "utf8").split("\n")) {
    if (line.trim() === "") {
      comment = [];
      continue;
    }
    if (line.startsWith("#")) {
      comment.push(line);
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match) {
      variables.push({ name: match[1], comment });
      comment = [];
    } else {
      malformed.push(line);
    }
  }
  return { variables, malformed };
}

describe(".env.example", () => {
  const example = parseEnvExample();

  it("holds only comments, blank lines and NAME=value assignments", () => {
    expect(example.malformed).toEqual([]);
  });

  it("names every variable the host or the compose stack reads, and nothing else, each once", () => {
    const documented = example.variables.map((variable) => variable.name);
    const expected = [
      ...ENV_CONFIG_KEY_NAMES,
      ...NODE_HOST_VARIABLE_NAMES,
      ...OBJECT_STORAGE_VARIABLE_NAMES,
      ...AWS_CREDENTIAL_VARIABLE_NAMES,
      ...COMPOSE_VARIABLES,
    ];
    expect([...documented].sort()).toEqual([...expected].sort());
  });

  it("marks exactly the keys a boot requires as Required.", () => {
    const marked = example.variables
      .filter((variable) => variable.comment[0]?.startsWith(REQUIRED_MARKER))
      .map((variable) => variable.name);
    expect(marked.sort()).toEqual([...REQUIRED_ENV_CONFIG_KEY_NAMES].sort());
  });
});
