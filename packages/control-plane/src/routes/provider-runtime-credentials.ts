/**
 * Delivery of stored provider secrets to sandboxes.
 *
 * `POST /sessions/:id/provider-auth/:provider/runtime-credential` is the
 * second result type of the sandbox broker boundary: where the access-token
 * route mints a short-lived brokered token per request (OpenAI, xAI), this
 * route hands the sandbox the stored static secret itself (a Claude setup
 * token), once per bridge start. It reads the session's immutable binding,
 * requires an active unarchived account, decrypts only after every check,
 * fences an expired credential to reconnect_required, records the issuance
 * under an active-account/version guard, and returns the plaintext with
 * Cache-Control: no-store.
 */

import { Hono } from "hono";
import { subscriptionProviderIdSchema } from "@open-inspect/shared/types/provider-accounts";
import { generateId } from "../auth/crypto";
import { modelProviderAccountAdapterRegistry } from "../auth/model-provider-account-default-adapters";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { ProviderCredentialStore } from "../db/provider-account-credentials";
import { ProviderCredentialIssuanceStore } from "../db/provider-credential-issuances";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
} from "./shared";

const logger = createLogger("router:provider-runtime-credentials");
/** A credential this close to its recorded expiry is treated as expired. */
const EXPIRY_GUARD_MS = 60 * 60 * 1000;

export const providerRuntimeCredentialRoutes = new Hono<ControlPlaneHonoEnv>();

interface StoredCredential {
  token: string;
  expiresAt: number;
}

function storedCredential(payload: unknown): StoredCredential | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.token !== "string" || record.token.length === 0) return null;
  if (typeof record.expiresAt !== "number") return null;
  return { token: record.token, expiresAt: record.expiresAt };
}

async function handleRuntimeCredential(
  request: Request,
  env: Env,
  params: { id: string; provider: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const sessionId = params.id;
  const parsedProvider = subscriptionProviderIdSchema.safeParse(params.provider);
  if (!parsedProvider.success) return error("Unsupported provider", 400);
  const provider = parsedProvider.data;
  const registry = modelProviderAccountAdapterRegistry;
  if (registry.runtimeCredentialKind(provider) !== "stored_provider_secret") {
    return error(
      "Provider does not deliver a stored provider secret; use the access-token route",
      409
    );
  }

  // The sandbox principal carries the authenticated sandbox id; a header
  // that names another sandbox is a stale or forged caller.
  const sandboxId = ctx.principal.sandboxId ?? null;
  const headerSandboxId = request.headers.get("X-Sandbox-ID");
  if (!sandboxId) return error("Sandbox identity unavailable", 403);
  if (headerSandboxId && headerSandboxId !== sandboxId) return error("Wrong sandbox", 403);

  let binding;
  try {
    binding = await new SessionIndexStore(ctx.db).getProviderAuthForProvider(sessionId, provider);
  } catch (cause) {
    logger.error("provider_credential.session_binding_lookup_failed", {
      event: "provider_credential.session_binding_lookup_failed",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      session_id: sessionId,
      provider,
      error: cause instanceof Error ? cause : String(cause),
    });
    return error("Session provider auth unavailable", 503);
  }
  if (!binding || binding.authMode !== "provider_account") {
    return error("Session does not use a connected provider account", 404);
  }

  const accounts = new ModelProviderAccountStore(ctx.db);
  const account = await accounts.getById(binding.providerAccountId);
  if (!account || account.provider !== provider) {
    return error("Provider account not found", 404);
  }
  if (account.archivedAt !== null) return error("Provider account is archived", 410);
  if (account.status !== "active") {
    return error(`Provider account is ${account.status.replace("_", " ")}`, 409);
  }

  const credentials = new ProviderCredentialStore(ctx.db, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY);
  const state = await credentials.readCredentialState(account.id, provider);
  if (!state) return error("Provider credential not found", 409);
  let credential: StoredCredential | null;
  try {
    const parsed = registry
      .require(provider)
      .parseCredential(state.payload, state.credentialSchemaVersion);
    credential = storedCredential(parsed);
  } catch {
    credential = null;
  }
  if (!credential) return error("Provider credential is unreadable", 409);

  const now = Date.now();
  if (credential.expiresAt - now <= EXPIRY_GUARD_MS) {
    // Local expiry is the one sandbox-adjacent signal allowed to fence the
    // account; the trigger enqueues the cleanup with this status change.
    await accounts.setStatus(account.id, "reconnect_required", null, now);
    logger.warn("provider_credential.expired", {
      event: "provider_credential.expired",
      provider,
      provider_account_id: account.id,
      session_id: sessionId,
    });
    return error("Provider credential has expired; reconnect the account", 409);
  }

  const issuances = new ProviderCredentialIssuanceStore(ctx.db);
  const recorded = await issuances.record({
    id: generateId(),
    providerAccountId: account.id,
    provider,
    sessionId,
    sandboxId,
    credentialVersion: state.credentialVersion,
    now,
  });
  if (!recorded) {
    // The account moved (disabled, archived, rotated) between the checks and
    // the record: never release a secret nobody will clean up after.
    // Retryable, unlike the other 409s: the sandbox client reads the flag and
    // treats this one as transient instead of a permanent denial.
    return json({ error: "Provider account changed during issuance; retry", retryable: true }, 409);
  }
  logger.info("provider_credential.issued", {
    event: "provider_credential.issued",
    provider,
    provider_account_id: account.id,
    session_id: sessionId,
    sandbox_id: sandboxId,
    credential_version: state.credentialVersion,
  });
  await accounts.touchLastUsed(account.id, account.lastUsedAt ?? 0, now).catch(() => false);
  return json({
    kind: "stored_provider_secret",
    secret: credential.token,
    credentialVersion: state.credentialVersion,
    expiresAt: credential.expiresAt,
  });
}

providerRuntimeCredentialRoutes.post(
  "/sessions/:id/provider-auth/:provider/runtime-credential",
  admit({
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
    cacheControl: "no-store",
    authorization: NO_AUTHORIZATION,
  }),
  (c) => dispatch(c, handleRuntimeCredential)
);
