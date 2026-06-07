/**
 * Managed Vercel base-runtime snapshot builder.
 *
 * This creates a temporary Vercel Sandbox, applies the shared runtime
 * bootstrap, snapshots the resulting filesystem, and stops the temporary
 * session. Terraform normally gives the temporary sandbox a deterministic
 * name and the control plane resolves that name to the latest snapshot ID.
 */

import { createLogger } from "../logger";
import type { CorrelationContext } from "../logger";
import {
  DEFAULT_VERCEL_RUNTIME,
  VERCEL_LOCAL_RUNTIME_EXTRACT_DIR,
  VERCEL_RUNTIME_WORKDIR,
  buildVercelBootstrapScript,
} from "./vercel-bootstrap";
import type { VercelSandboxClient } from "./vercel-client";

const log = createLogger("vercel-base-snapshot");

const DEFAULT_BASE_SNAPSHOT_NAME_PREFIX = "openinspect-base";
const DEFAULT_BASE_SNAPSHOT_TIMEOUT_MS = 30 * 60 * 1000;
const PREPARE_RUNTIME_UPLOAD_TIMEOUT_MS = 30_000;
const BOOTSTRAP_TIMEOUT_MS = 20 * 60 * 1000;

export interface BuildVercelBaseSnapshotConfig {
  runtime?: string;
  runtimeArchive: Uint8Array;
  runtimeExtractDir?: string;
  sourceVersion?: string;
  sandboxName?: string;
  namePrefix?: string;
  now?: number;
  correlation?: CorrelationContext;
}

export interface BuildVercelBaseSnapshotResult {
  snapshotId: string;
  sandboxName: string;
  sessionId: string;
}

export async function buildVercelBaseSnapshot(
  client: VercelSandboxClient,
  config: BuildVercelBaseSnapshotConfig
): Promise<BuildVercelBaseSnapshotResult> {
  const runtimeExtractDir = config.runtimeExtractDir || VERCEL_LOCAL_RUNTIME_EXTRACT_DIR;
  const runtimeSourceRef = config.sourceVersion || "local-checkout";
  const sandboxName =
    config.sandboxName ||
    buildBaseSnapshotSandboxName({
      prefix: config.namePrefix || DEFAULT_BASE_SNAPSHOT_NAME_PREFIX,
      sourceVersion: config.sourceVersion,
      now: config.now ?? Date.now(),
    });

  const created = await client.createSandbox(
    {
      name: sandboxName,
      runtime: config.runtime || DEFAULT_VERCEL_RUNTIME,
      timeoutMs: DEFAULT_BASE_SNAPSHOT_TIMEOUT_MS,
      ports: [],
      tags: {
        openinspect_framework: "open-inspect",
        openinspect_kind: "base-runtime-build",
        openinspect_runtime_source: "local-checkout",
        openinspect_runtime_ref: runtimeSourceRef,
        ...(config.sourceVersion ? { openinspect_source_version: config.sourceVersion } : {}),
      },
    },
    config.correlation
  );

  const sessionId = created.session.id;
  try {
    const prepareResult = await client.runCommandAndWait(
      {
        sessionId,
        command: "bash",
        args: [
          "-lc",
          `rm -rf ${shellQuote(VERCEL_RUNTIME_WORKDIR)} && mkdir -p ${shellQuote(runtimeExtractDir)}`,
        ],
        timeoutMs: PREPARE_RUNTIME_UPLOAD_TIMEOUT_MS,
      },
      config.correlation
    );
    if (prepareResult.exitCode !== 0) {
      throw new Error(
        `Vercel base runtime upload directory preparation failed with exit code ${prepareResult.exitCode}`
      );
    }

    await client.writeFileArchive(
      {
        sessionId,
        archive: config.runtimeArchive,
        extractDir: runtimeExtractDir,
      },
      config.correlation
    );

    const result = await client.runCommandAndWait(
      {
        sessionId,
        command: "bash",
        args: ["-lc", buildVercelBootstrapScript({ runtimeExtractDir })],
        timeoutMs: BOOTSTRAP_TIMEOUT_MS,
      },
      config.correlation
    );

    if (result.exitCode !== 0) {
      throw new Error(`Vercel base runtime bootstrap failed with exit code ${result.exitCode}`);
    }

    const snapshot = await client.snapshotSession(
      sessionId,
      { expirationMs: 0 },
      config.correlation
    );

    if (snapshot.snapshot.status !== "created") {
      throw new Error(`Vercel base snapshot status was ${snapshot.snapshot.status}`);
    }

    log.info("vercel_base_snapshot.created", {
      snapshot_id: snapshot.snapshot.id,
      sandbox_name: sandboxName,
      session_id: sessionId,
      runtime_source: "local-checkout",
      runtime_source_ref: runtimeSourceRef,
    });

    return {
      snapshotId: snapshot.snapshot.id,
      sandboxName,
      sessionId,
    };
  } finally {
    try {
      await client.stopSession(sessionId, config.correlation);
    } catch (error) {
      log.warn("vercel_base_snapshot.stop_failed", {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function buildBaseSnapshotSandboxName(params: {
  prefix: string;
  sourceVersion?: string;
  now: number;
}): string {
  const source = params.sourceVersion ? params.sourceVersion.slice(0, 12) : "manual";
  const raw = `${params.prefix}-${source}-${params.now}`;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized.slice(0, 96) || `${DEFAULT_BASE_SNAPSHOT_NAME_PREFIX}-${params.now}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
