export const VALID_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_KEY_LENGTH = 256;
export const MAX_VALUE_SIZE = 16384;
export const MAX_TOTAL_VALUE_SIZE = 65536;
export const MAX_SECRETS_PER_SCOPE = 50;

export const RESERVED_KEYS = new Set([
  "PYTHONUNBUFFERED",
  "SANDBOX_ID",
  "CONTROL_PLANE_URL",
  "SANDBOX_AUTH_TOKEN",
  "REPO_OWNER",
  "REPO_NAME",
  "GITHUB_APP_TOKEN",
  "SESSION_CONFIG",
  "RESTORED_FROM_SNAPSHOT",
  "OPENCODE_CONFIG_CONTENT",
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "PWD",
  "LANG",
]);

export class SecretsValidationError extends Error {}

export interface SecretMetadata {
  key: string;
  createdAt: number;
  updatedAt: number;
}

export function normalizeKey(key: string): string {
  return key.toUpperCase();
}

export function validateKey(key: string): void {
  if (!key || key.length > MAX_KEY_LENGTH)
    throw new SecretsValidationError("Key too long or empty");
  if (!VALID_KEY_PATTERN.test(key))
    throw new SecretsValidationError("Key must match [A-Za-z_][A-Za-z0-9_]*");
  if (RESERVED_KEYS.has(key.toUpperCase()))
    throw new SecretsValidationError(`Key '${key}' is reserved`);
}

export function validateValue(value: string): void {
  if (typeof value !== "string") throw new SecretsValidationError("Value must be a string");
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_VALUE_SIZE)
    throw new SecretsValidationError(`Value exceeds ${MAX_VALUE_SIZE} bytes`);
}

/** Combined byte ceiling for a session's merged secret payload (128 KiB). */
export const MAX_COMBINED_SECRETS_BYTES = 131072;

/** A named contributor to a session's secret set, lowest precedence first. */
export interface SecretSource {
  /** Stable label for byte attribution and collision logs (e.g. "global", "acme/web"). */
  label: string;
  secrets: Record<string, string>;
}

/** One source's contribution to the final merged payload (after overrides). */
export interface SecretSourceAttribution {
  label: string;
  /** Keys this source owns in the merged payload. */
  keyCount: number;
  /** Bytes those owned keys' values contribute to the payload. */
  bytes: number;
}

/** A key defined by more than one source; the higher-precedence source wins. */
export interface SecretKeyCollision {
  key: string;
  /** Label of the source whose value is used. */
  winner: string;
  /** Label of the overridden source. */
  loser: string;
}

export interface MergedSecrets {
  merged: Record<string, string>;
  totalBytes: number;
  maxCombinedBytes: number;
  exceedsLimit: boolean;
  /** Per-source contribution, in input (lowest-first) order, sources with keys only. */
  attribution: SecretSourceAttribution[];
  /** Cross-source key collisions, in the order they were resolved. */
  collisions: SecretKeyCollision[];
}

/**
 * Fold an ordered list of secret sources into one payload. Sources are given
 * lowest precedence first; a later source's key overrides (case-insensitively)
 * an earlier one's — so `[global, repoB, repoA]` lets repoA win, which is how
 * the session-target fold passes the primary member last (design §6.4). Reports
 * per-source byte attribution and cross-source collisions for the cap-check and
 * collision warnings; the pure merge stays identical to the old two-arg
 * `mergeSecrets(global, repo)` for the single-source-plus-global case.
 */
export function mergeSecretSources(
  sources: SecretSource[],
  maxCombinedBytes = MAX_COMBINED_SECRETS_BYTES
): MergedSecrets {
  const merged: Record<string, string> = {};
  const owner = new Map<string, string>(); // normalized key -> winning source label
  const collisions: SecretKeyCollision[] = [];

  for (const source of sources) {
    for (const [rawKey, value] of Object.entries(source.secrets)) {
      const key = normalizeKey(rawKey);
      const prevOwner = owner.get(key);
      if (prevOwner !== undefined && prevOwner !== source.label) {
        collisions.push({ key, winner: source.label, loser: prevOwner });
      }
      merged[key] = value;
      owner.set(key, source.label);
    }
  }

  const encoder = new TextEncoder();
  const bytesByLabel = new Map<string, number>();
  const keysByLabel = new Map<string, number>();
  let totalBytes = 0;
  for (const [key, value] of Object.entries(merged)) {
    const bytes = encoder.encode(value).length;
    totalBytes += bytes;
    const label = owner.get(key)!;
    bytesByLabel.set(label, (bytesByLabel.get(label) ?? 0) + bytes);
    keysByLabel.set(label, (keysByLabel.get(label) ?? 0) + 1);
  }

  // Attribution follows input order; a source that owns no surviving key is omitted.
  const emitted = new Set<string>();
  const attribution: SecretSourceAttribution[] = [];
  for (const source of sources) {
    if (emitted.has(source.label)) continue;
    emitted.add(source.label);
    const keyCount = keysByLabel.get(source.label) ?? 0;
    if (keyCount === 0) continue;
    attribution.push({ label: source.label, keyCount, bytes: bytesByLabel.get(source.label) ?? 0 });
  }

  return {
    merged,
    totalBytes,
    maxCombinedBytes,
    exceedsLimit: totalBytes > maxCombinedBytes,
    attribution,
    collisions,
  };
}

/**
 * Cap enforcement mode. `warn` logs an oversized payload and proceeds (the
 * warn-staged rollout behavior plus telemetry); `enforce` rejects the
 * spawn/build. Defaults to `enforce` (D§6.4's ship-enforced spec) now that the
 * Phase-1 gate has passed the warn window; set `SECRETS_CAP_ENFORCEMENT=warn`
 * on the worker to fall back without a code revert. Fail-closed: only the
 * literal `warn` opts out, so an unset or garbled value still enforces.
 */
export type SecretsCapMode = "warn" | "enforce";

export function parseSecretsCapMode(value: string | undefined): SecretsCapMode {
  return value === "warn" ? "warn" : "enforce";
}

/** Thrown in `enforce` mode when a merged payload exceeds the combined cap. */
export class SecretsCapExceededError extends Error {
  constructor(
    readonly totalBytes: number,
    readonly maxCombinedBytes: number,
    readonly attribution: SecretSourceAttribution[]
  ) {
    super(
      `Combined secrets payload is ${totalBytes} bytes, over the ${maxCombinedBytes}-byte limit. ` +
        `Reduce secrets in: ${formatSecretsAttribution(attribution)}.`
    );
    this.name = "SecretsCapExceededError";
  }
}

/** Render attribution largest-first for a cap error/log (never includes values). */
export function formatSecretsAttribution(attribution: SecretSourceAttribution[]): string {
  return [...attribution]
    .sort((a, b) => b.bytes - a.bytes)
    .map((entry) => `${entry.label} (${entry.bytes} bytes, ${entry.keyCount} keys)`)
    .join(", ");
}

interface SecretsAuditLog {
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Log a merged payload's cross-source collisions and cap decision, and — in
 * `enforce` mode — throw `SecretsCapExceededError` when over the limit. Shared
 * by the spawn path (`getUserEnvVars`) and the repo-image build planner so both
 * apply the cap identically. In `warn` mode nothing is thrown; the caller keeps
 * using the oversized payload.
 */
export function auditSecretsMerge(params: {
  merge: MergedSecrets;
  mode: SecretsCapMode;
  log: SecretsAuditLog;
  context?: Record<string, unknown>;
}): void {
  const { merge, mode, log, context = {} } = params;
  for (const collision of merge.collisions) {
    log.warn("secrets.key_collision", {
      key: collision.key,
      winner: collision.winner,
      overridden: collision.loser,
      ...context,
    });
  }
  if (!merge.exceedsLimit) return;

  const fields = {
    total_bytes: merge.totalBytes,
    max_bytes: merge.maxCombinedBytes,
    enforcement: mode,
    attribution: merge.attribution.map((entry) => ({
      scope: entry.label,
      bytes: entry.bytes,
      keys: entry.keyCount,
    })),
    ...context,
  };
  if (mode === "enforce") {
    log.error("secrets.cap_exceeded", fields);
    throw new SecretsCapExceededError(merge.totalBytes, merge.maxCombinedBytes, merge.attribution);
  }
  log.warn("secrets.cap_exceeded", fields);
}
