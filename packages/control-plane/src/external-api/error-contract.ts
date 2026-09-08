import type { Env } from "../types";
import type { RequestContext, RoutePolicy } from "../routes/shared";
import {
  listCurrentManagedSecretValues,
  listManagedSecretHistory,
} from "../db/managed-secret-redaction-history";
import { decryptToken } from "../auth/crypto";
import { decryptProviderAccountPayload } from "../auth/provider-account-crypto";
import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";
export async function withExternalErrorContract(
  response: Response,
  contract: RoutePolicy["errorContract"],
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  if (contract !== "external-v1" || response.ok) return response;
  const raw: unknown = await response
    .clone()
    .json()
    .catch(() => ({}));
  const payload =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const message = typeof payload.error === "string" ? payload.error : "Request failed";
  const code = typeof payload.code === "string" ? payload.code : externalErrorCode(response.status);
  let redactedPayload = { ...payload, error: message, code, message, requestId: ctx.request_id };
  if (env.REPO_SECRETS_ENCRYPTION_KEY) {
    const values = new Set([
      ...(await listCurrentManagedSecretValues(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY)),
      ...(await listManagedSecretHistory(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY)),
      ...(await externalCredentialRedactions(env, ctx)),
    ]);
    redactedPayload = redactExactStrings(redactedPayload, values) as typeof redactedPayload;
  }
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(redactedPayload), { status: response.status, headers });
}

async function externalCredentialRedactions(env: Env, ctx: RequestContext): Promise<string[]> {
  const values: string[] = [];
  const mcpRows = await ctx.db
    .prepare(
      `SELECT env AS encrypted_env FROM mcp_servers
       UNION ALL SELECT encrypted_env FROM mcp_credential_redaction_history`
    )
    .all<{ encrypted_env: string }>();
  for (const { encrypted_env } of mcpRows.results ?? []) {
    if (!encrypted_env || ["{}", "null"].includes(encrypted_env)) continue;
    try {
      collectRedactionStrings(
        JSON.parse(await decryptToken(encrypted_env, env.REPO_SECRETS_ENCRYPTION_KEY!)),
        values
      );
    } catch {
      collectRedactionStrings(JSON.parse(encrypted_env), values);
    }
  }
  const scmRows = await ctx.db
    .prepare(
      `SELECT access_token_encrypted, refresh_token_encrypted FROM user_scm_tokens
       UNION ALL
       SELECT access_token_encrypted, refresh_token_encrypted
       FROM scm_credential_redaction_history`
    )
    .all<{ access_token_encrypted: string; refresh_token_encrypted: string }>();
  for (const row of scmRows.results ?? []) {
    values.push(
      await decryptToken(row.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY),
      await decryptToken(row.refresh_token_encrypted, env.TOKEN_ENCRYPTION_KEY)
    );
  }
  const providerRows = await ctx.db
    .prepare(
      `SELECT credentials.provider_account_id, accounts.provider,
              credentials.credential_schema_version, credentials.encrypted_payload
       FROM model_provider_account_credentials credentials
       JOIN model_provider_accounts accounts ON accounts.id = credentials.provider_account_id
       UNION ALL
       SELECT provider_account_id, provider, credential_schema_version, encrypted_payload
       FROM provider_credential_redaction_history`
    )
    .all<{
      provider_account_id: string;
      provider: ModelProviderId;
      credential_schema_version: number;
      encrypted_payload: string;
    }>();
  for (const row of providerRows.results ?? []) {
    collectRedactionStrings(
      await decryptProviderAccountPayload(
        row.encrypted_payload,
        env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY,
        {
          providerAccountId: row.provider_account_id,
          provider: row.provider,
          credentialSchemaVersion: row.credential_schema_version,
        }
      ),
      values
    );
  }
  return values;
}

function collectRedactionStrings(value: unknown, target: string[]): void {
  if (typeof value === "string") target.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectRedactionStrings(entry, target));
  else if (value && typeof value === "object")
    Object.values(value).forEach((entry) => collectRedactionStrings(entry, target));
}

function redactExactStrings(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of secrets) if (secret) redacted = redacted.split(secret).join("[REDACTED]");
    return redacted;
  }
  if (Array.isArray(value)) return value.map((entry) => redactExactStrings(entry, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactExactStrings(entry, secrets)])
    );
  return value;
}

function externalErrorCode(status: number): string {
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 410) return "checkpoint_expired";
  if (status === 429) return "rate_limited";
  if (status === 426) return "incompatible_client";
  return "service_unavailable";
}
