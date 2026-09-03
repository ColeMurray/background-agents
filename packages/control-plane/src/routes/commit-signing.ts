import { commitSigningWriteRequestSchema } from "@open-inspect/shared/types/commit-signing";
import { Hono } from "hono";

import {
  OpenSshKeyValidationError,
  signGitPayloadWithOpenSshEd25519PrivateKey,
  validateOpenSshEd25519PrivateKey,
} from "../auth/openssh-ed25519";
import { CommitSigningStore } from "../db/commit-signing";
import type { SqlDatabase } from "../db/sql-database";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { resolveScmProviderFromEnv } from "../source-control";
import type { Env } from "../types";
import {
  error,
  json,
  parseJsonBody,
  type RequestContext,
  GITHUB_USER_OR_SERVICE_ROUTE,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  NO_AUTHORIZATION,
  requirePermission,
} from "./shared";

const MAX_SIGNING_PAYLOAD_BYTES = 1024 * 1024;

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function createStore(env: Env, db: SqlDatabase): CommitSigningStore | Response {
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return noStore(error("Commit signing encryption is not configured", 503));
  }
  return new CommitSigningStore(db, env.REPO_SECRETS_ENCRYPTION_KEY);
}

async function readSigningPayload(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_SIGNING_PAYLOAD_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

async function handleGetCommitSigning(
  _request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const store = createStore(env, ctx.db);
  if (store instanceof Response) return store;

  try {
    const metadata = await store.getMetadata();
    return noStore(json(metadata ? { enabled: true, ...metadata } : { enabled: false }));
  } catch {
    return noStore(error("Commit signing storage unavailable", 503));
  }
}

async function handlePutCommitSigning(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const store = createStore(env, ctx.db);
  if (store instanceof Response) return store;

  const unparsedBody = await parseJsonBody<unknown>(request);
  if (unparsedBody instanceof Response) return noStore(unparsedBody);
  const parsedBody = commitSigningWriteRequestSchema.safeParse(unparsedBody);
  if (!parsedBody.success) {
    return noStore(error("Invalid commit signing configuration", 400));
  }

  try {
    const validatedKey = await validateOpenSshEd25519PrivateKey(parsedBody.data.privateKey);
    const metadata = await store.save({
      ...parsedBody.data,
      ...validatedKey,
    });
    return noStore(json({ enabled: true, ...metadata }));
  } catch (caught) {
    const validationFailure = caught instanceof OpenSshKeyValidationError;
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
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const store = createStore(env, ctx.db);
  if (store instanceof Response) return store;

  try {
    await store.delete();
    return noStore(json({ enabled: false }));
  } catch {
    return noStore(error("Commit signing storage unavailable", 503));
  }
}

async function handleGetSandboxCommitSigning(
  _request: Request,
  env: Env,
  _params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  // The bridge runs on every supported SCM deployment. Signing is GitHub-only,
  // so other providers receive the explicit disabled state required for safe
  // unsigned execution instead of failing the session at the provider gate.
  if (resolveScmProviderFromEnv(env.SCM_PROVIDER) !== "github") {
    return noStore(json({ enabled: false }));
  }

  const store = createStore(env, ctx.db);
  if (store instanceof Response) return store;

  try {
    const configuration = await store.getRuntimeConfiguration();
    return noStore(json(configuration ? { enabled: true, ...configuration } : { enabled: false }));
  } catch {
    return noStore(error("Commit signing configuration unavailable", 503));
  }
}

async function handlePostSandboxCommitSigning(
  request: Request,
  env: Env,
  _params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  if (resolveScmProviderFromEnv(env.SCM_PROVIDER) !== "github") {
    return noStore(error("Commit signing is disabled", 409));
  }

  const requestedFingerprint = request.headers.get("X-Open-Inspect-Signing-Fingerprint");
  if (!requestedFingerprint) {
    return noStore(error("Commit signing fingerprint required", 400));
  }
  const payload = await readSigningPayload(request);
  if (!payload) return noStore(error("Commit signing payload is too large", 413));
  if (payload.length === 0) return noStore(error("Commit signing payload required", 400));

  const store = createStore(env, ctx.db);
  if (store instanceof Response) return store;

  try {
    const configuration = await store.getDecryptedSigningConfiguration();
    if (!configuration) return noStore(error("Commit signing is disabled", 409));
    if (configuration.fingerprint !== requestedFingerprint) {
      return noStore(error("Commit signing key changed", 409));
    }

    const signature = await signGitPayloadWithOpenSshEd25519PrivateKey(
      configuration.privateKey,
      payload
    );
    if (
      signature.fingerprint !== configuration.fingerprint ||
      signature.publicKey !== configuration.publicKey
    ) {
      throw new Error("Configured signing key metadata mismatch");
    }
    return noStore(
      new Response(signature.armoredSignature, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  } catch {
    return noStore(error("Commit signing unavailable", 503));
  }
}

const COMMIT_SIGNING_MANAGE = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("commit_signing.manage"),
});
const SANDBOX = admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION });

export const commitSigningRoutes = new Hono<ControlPlaneHonoEnv>();

commitSigningRoutes.get(
  "/commit-signing",
  admit({ ...GITHUB_USER_OR_SERVICE_ROUTE, authorization: requirePermission("integrations.read") }),
  (c) => dispatch(c, handleGetCommitSigning)
);
commitSigningRoutes.put("/commit-signing", COMMIT_SIGNING_MANAGE, (c) =>
  dispatch(c, handlePutCommitSigning)
);
commitSigningRoutes.delete("/commit-signing", COMMIT_SIGNING_MANAGE, (c) =>
  dispatch(c, handleDeleteCommitSigning)
);
commitSigningRoutes.get("/sessions/:id/commit-signing", SANDBOX, (c) =>
  dispatch(c, handleGetSandboxCommitSigning)
);
commitSigningRoutes.post("/sessions/:id/commit-signing", SANDBOX, (c) =>
  dispatch(c, handlePostSandboxCommitSigning)
);
