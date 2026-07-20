import { commitSigningWriteRequestSchema } from "@open-inspect/shared";

import {
  OpenSshKeyValidationError,
  signGitPayloadWithOpenSshEd25519PrivateKey,
  validateOpenSshEd25519PrivateKey,
} from "../auth/openssh-ed25519";
import { CommitSigningStore } from "../db/commit-signing";
import type { SqlDatabase } from "../db/sql-database";
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
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const store = createStore(env, ctx.db);
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
    return noStore(json(metadata));
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
  _match: RegExpMatchArray,
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

  const store = createStore(env, ctx.db);
  if (store instanceof Response) return store;

  try {
    return noStore(json(await store.getRuntimeConfiguration()));
  } catch {
    return noStore(error("Commit signing configuration unavailable", 503));
  }
}

async function handlePostSandboxCommitSigning(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return noStore(error("Session ID required", 400));
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
    if (!configuration.enabled) return noStore(error("Commit signing is disabled", 409));
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
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/commit-signing"),
    handler: handlePostSandboxCommitSigning,
  },
];
