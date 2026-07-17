import { commitSigningWriteRequestSchema } from "@open-inspect/shared";

import {
  OpenSshKeyValidationError,
  validateOpenSshEd25519PrivateKey,
} from "../auth/openssh-ed25519";
import { CommitSigningStore } from "../db/commit-signing";
import { createLogger } from "../logger";
import { resolveScmProviderFromEnv } from "../source-control";
import type { Env } from "../types";
import {
  error,
  json,
  parseJsonBody,
  parsePattern,
  type RequestContext,
  type Route,
} from "./shared";

const logger = createLogger("router:commit-signing");

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function createStore(env: Env): CommitSigningStore | Response {
  if (!env.DB) return noStore(error("Commit signing storage is not configured", 503));
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return noStore(error("Commit signing encryption is not configured", 503));
  }
  return new CommitSigningStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
}

async function handleGetCommitSigning(_request: Request, env: Env): Promise<Response> {
  const store = createStore(env);
  if (store instanceof Response) return store;

  try {
    return noStore(json(await store.getMetadata()));
  } catch {
    return noStore(error("Commit signing storage unavailable", 503));
  }
}

async function handlePutCommitSigning(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const store = createStore(env);
  if (store instanceof Response) return store;

  let action: "configure" | "replace" = "configure";
  try {
    action = (await store.getMetadata()).enabled ? "replace" : "configure";
  } catch {
    return noStore(error("Commit signing storage unavailable", 503));
  }

  const unparsedBody = await parseJsonBody<unknown>(request);
  if (unparsedBody instanceof Response) return noStore(unparsedBody);
  const parsedBody = commitSigningWriteRequestSchema.safeParse(unparsedBody);
  if (!parsedBody.success) {
    logger.warn("commit_signing.configuration_changed", {
      event: "commit_signing.configuration_changed",
      action,
      outcome: "validation_failed",
      reason: "invalid_request",
      timestamp: Date.now(),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return noStore(error("Invalid commit signing configuration", 400));
  }

  try {
    const validatedAt = Date.now();
    const validatedKey = await validateOpenSshEd25519PrivateKey(parsedBody.data.privateKey);
    const metadata = await store.save({
      ...parsedBody.data,
      ...validatedKey,
      validatedAt,
    });
    logger.info("commit_signing.configuration_changed", {
      event: "commit_signing.configuration_changed",
      action,
      fingerprint: validatedKey.fingerprint,
      outcome: "success",
      timestamp: validatedAt,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return noStore(json(metadata));
  } catch (caught) {
    const validationFailure = caught instanceof OpenSshKeyValidationError;
    logger[validationFailure ? "warn" : "error"]("commit_signing.configuration_changed", {
      event: "commit_signing.configuration_changed",
      action,
      outcome: validationFailure ? "validation_failed" : "error",
      reason: validationFailure ? "invalid_key" : "storage_unavailable",
      timestamp: Date.now(),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return noStore(
      validationFailure
        ? error(caught.message, 400)
        : error("Commit signing storage unavailable", 503)
    );
  }
}

async function handleDeleteCommitSigning(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const store = createStore(env);
  if (store instanceof Response) return store;

  try {
    const metadata = await store.getMetadata();
    await store.delete();
    logger.info("commit_signing.configuration_changed", {
      event: "commit_signing.configuration_changed",
      action: "disable",
      ...(metadata.enabled ? { fingerprint: metadata.fingerprint } : {}),
      outcome: "success",
      timestamp: Date.now(),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return noStore(json({ enabled: false }));
  } catch {
    logger.error("commit_signing.configuration_changed", {
      event: "commit_signing.configuration_changed",
      action: "disable",
      outcome: "error",
      reason: "storage_unavailable",
      timestamp: Date.now(),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return noStore(error("Commit signing storage unavailable", 503));
  }
}

async function handleGetSandboxCommitSigning(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return noStore(error("Session ID required", 400));

  // The bridge runs on every supported SCM deployment. Signing is GitHub-only,
  // so other providers receive the explicit disabled state required for safe
  // unsigned execution instead of failing the session at the provider gate.
  if (resolveScmProviderFromEnv(env.SCM_PROVIDER) !== "github") {
    return noStore(json({ enabled: false }));
  }

  const store = createStore(env);
  if (store instanceof Response) return store;

  try {
    const configuration = await store.getDecryptedConfiguration();
    logger.info("commit_signing.configuration_brokered", {
      event: "commit_signing.configuration_brokered",
      session_id: sessionId,
      outcome: "success",
      enabled: configuration.enabled,
      ...(configuration.enabled ? { fingerprint: configuration.fingerprint } : {}),
      timestamp: Date.now(),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return noStore(json(configuration));
  } catch {
    logger.error("commit_signing.configuration_brokered", {
      event: "commit_signing.configuration_brokered",
      session_id: sessionId,
      outcome: "error",
      reason: "decryption_failed",
      timestamp: Date.now(),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return noStore(error("Commit signing configuration unavailable", 503));
  }
}

export const commitSigningRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/commit-signing"),
    handler: handleGetCommitSigning,
  },
  {
    method: "PUT",
    pattern: parsePattern("/commit-signing"),
    handler: handlePutCommitSigning,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/commit-signing"),
    handler: handleDeleteCommitSigning,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/commit-signing"),
    handler: handleGetSandboxCommitSigning,
  },
];
