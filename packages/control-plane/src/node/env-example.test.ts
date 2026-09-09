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

/** The compose file, which has required variables of its own beyond the host's. */
const COMPOSE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../docker-compose.yml"
);

/** The document whose quick start is the bring-up a clean checkout is expected to follow. */
const CONTAINER_DOC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/CONTROL_PLANE_CONTAINER.md"
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
  /** What the file ships as the value; empty means the operator has to supply one. */
  value: string;
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
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) {
      variables.push({ name: match[1], comment, value: readEnvValue(match[2]) });
      comment = [];
    } else {
      malformed.push(line);
    }
  }
  return { variables, malformed };
}

/**
 * The value dotenv would hand the process: an unquoted value ends at a comment,
 * and a quoted one is its contents. `KEY=""` and `KEY= # unset` are both empty,
 * and a check that read the raw text would take either for a supplied value.
 */
function readEnvValue(raw: string): string {
  const quoted = /^\s*(["'])(.*?)\1\s*(?:#.*)?$/.exec(raw);
  if (quoted) return quoted[2];
  return raw.split("#")[0].trim();
}

/** The variables docker-compose.yml refuses to start without: `${NAME:?message}`. */
function readComposeRequiredVariables(): string[] {
  const compose = readFileSync(COMPOSE_PATH, "utf8");
  const names = new Set<string>();
  for (const match of compose.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?/g)) names.add(match[1]);
  return [...names];
}

/** The "## Quick start" section of the container document, and no other section. */
function readQuickStart(): string {
  const doc = readFileSync(CONTAINER_DOC_PATH, "utf8");
  const start = doc.indexOf("\n## Quick start\n");
  if (start === -1) throw new Error("CONTROL_PLANE_CONTAINER.md has no Quick start section");
  const end = doc.indexOf("\n## ", start + 1);
  return end === -1 ? doc.slice(start) : doc.slice(start, end);
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

  /**
   * A copy of this file plus the documented quick start has to produce a stack that
   * comes up. A required key may therefore ship a working value, or be one the quick
   * start names as an operator's to supply — the encryption keys, which cannot have
   * a default. A key that is neither is a crash loop on a clean checkout, and the
   * compose smoke cannot catch it: that script writes its own environment file.
   *
   * "Required" spans both gates a bring-up passes through: `readEnvConfig`, which
   * the host checks before it listens, and the `${NAME:?}` variables compose refuses
   * to start without. Both sets are read from the artifacts that enforce them, so
   * neither can drift from this test.
   *
   * The set is iterated, not the file, so deleting an assignment outright reads as
   * the empty value it becomes rather than dropping out of the check.
   */
  it("gives every required variable a value, or has the quick start ask for it", () => {
    const required = new Set<string>([
      ...REQUIRED_ENV_CONFIG_KEY_NAMES,
      ...readComposeRequiredVariables(),
    ]);
    const quickStart = readQuickStart();
    const shipped = new Map(example.variables.map(({ name, value }) => [name, value]));
    const unsupplied = [...required]
      .filter((name) => (shipped.get(name) ?? "") === "" && !quickStart.includes(name))
      .sort();
    expect(unsupplied).toEqual([]);
  });
});
