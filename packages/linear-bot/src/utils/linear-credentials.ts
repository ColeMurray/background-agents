import type { Env, StoredLinearClientCredentialsToken } from "../types";
import { createLogger } from "../logger";
import {
  deleteLegacyOAuthToken,
  readClientCredentialCache,
  writeClientCredentialCache,
} from "./linear-credential-cache";
import {
  exchangeLinearAuthorizationCode,
  fetchLinearIdentity,
  issueLinearClientCredentialsToken,
  LINEAR_CLIENT_CREDENTIALS_SCOPE,
  LinearAuthError,
  LinearIdentityError,
  type IssuedClientCredentialsToken,
  type LinearIdentity,
} from "./linear-oauth";

export {
  LINEAR_CLIENT_CREDENTIALS_SCOPE,
  LinearAuthError,
  type LinearAuthFailure,
  type LinearAuthFailureReason,
} from "./linear-oauth";

const log = createLogger("linear-credentials");

interface ClientCredentialOptions {
  forceRenew?: boolean;
  expectedAppUserId?: string;
}

async function issueVerifiedCredential(
  env: Env,
  organizationId: string,
  expectedAppUserId?: string
): Promise<StoredLinearClientCredentialsToken> {
  log.info("oauth.client_credentials.issue", { org_id: organizationId });

  let issued: IssuedClientCredentialsToken;
  try {
    issued = await issueLinearClientCredentialsToken(env);
  } catch (error) {
    const failure =
      error instanceof LinearAuthError
        ? error
        : new LinearAuthError({ reason: "client_credentials_error" });
    log.error("oauth.client_credentials.issue_failed", {
      org_id: organizationId,
      auth_failure_reason: failure.reason,
      status: failure.status,
      oauth_error: failure.oauthError,
    });
    throw failure;
  }

  let identity: LinearIdentity;
  try {
    identity = await fetchLinearIdentity(issued.accessToken);
  } catch (error) {
    const status = error instanceof LinearIdentityError ? error.status : undefined;
    log.error("oauth.client_credentials.identity_failed", {
      org_id: organizationId,
      status,
    });
    throw new LinearAuthError({
      reason: "client_credentials_identity_error",
      status,
    });
  }

  if (identity.organizationId !== organizationId) {
    log.error("oauth.client_credentials.workspace_mismatch", {
      org_id: organizationId,
      actual_org_id: identity.organizationId,
    });
    throw new LinearAuthError({ reason: "client_credentials_workspace_mismatch" });
  }
  if (expectedAppUserId && identity.appUserId !== expectedAppUserId) {
    log.error("oauth.client_credentials.identity_failed", {
      org_id: organizationId,
      expected_app_user_id: expectedAppUserId,
      actual_app_user_id: identity.appUserId,
    });
    throw new LinearAuthError({ reason: "client_credentials_app_user_mismatch" });
  }

  return {
    version: 1,
    access_token: issued.accessToken,
    token_type: "Bearer",
    scope: LINEAR_CLIENT_CREDENTIALS_SCOPE,
    issued_at: issued.issuedAt,
    expires_at: issued.expiresAt,
    organization_id: identity.organizationId,
    organization_name: identity.organizationName,
    app_user_id: identity.appUserId,
  };
}

async function persistVerifiedCredential(
  env: Env,
  credential: StoredLinearClientCredentialsToken
): Promise<void> {
  await writeClientCredentialCache(env, credential);
  try {
    await deleteLegacyOAuthToken(env, credential.organization_id);
    log.info("oauth.legacy_token_deleted", { org_id: credential.organization_id });
  } catch (error) {
    log.error("oauth.legacy_token_delete_failed", {
      org_id: credential.organization_id,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

async function readUsableCredential(
  env: Env,
  organizationId: string,
  expectedAppUserId?: string
): Promise<string | null> {
  try {
    const cached = await readClientCredentialCache(env, organizationId, expectedAppUserId);
    if (cached.status === "hit") {
      log.info("oauth.client_credentials.cache_hit", { org_id: organizationId });
      return cached.token.access_token;
    }
    log.info("oauth.client_credentials.cache_miss", {
      org_id: organizationId,
      cache_reason: cached.reason,
    });
  } catch (error) {
    log.error("oauth.client_credentials.cache_read_failed", {
      org_id: organizationId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
  return null;
}

export async function getClientCredentialsTokenOrThrow(
  env: Env,
  organizationId: string,
  options: ClientCredentialOptions = {}
): Promise<string> {
  if (!options.forceRenew) {
    const cachedToken = await readUsableCredential(env, organizationId, options.expectedAppUserId);
    if (cachedToken) return cachedToken;
  }

  const credential = await issueVerifiedCredential(env, organizationId, options.expectedAppUserId);
  try {
    await persistVerifiedCredential(env, credential);
  } catch (error) {
    log.error("oauth.client_credentials.cache_write_failed", {
      org_id: organizationId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  log.info("oauth.client_credentials.issued", {
    org_id: organizationId,
    app_user_id: credential.app_user_id,
    expires_at: credential.expires_at,
  });
  return credential.access_token;
}

export async function completeLinearOAuthInstallation(
  env: Env,
  code: string
): Promise<{ orgName: string }> {
  const installationToken = await exchangeLinearAuthorizationCode(env, code);
  const installationIdentity = await fetchLinearIdentity(installationToken.access_token);
  const runtimeCredential = await issueVerifiedCredential(
    env,
    installationIdentity.organizationId,
    installationIdentity.appUserId
  );

  // Installation is not complete until a future Worker invocation can load the runtime credential.
  await persistVerifiedCredential(env, runtimeCredential);
  return { orgName: installationIdentity.organizationName };
}
