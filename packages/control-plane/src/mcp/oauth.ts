import { z } from "zod";
import { hashToken, generateId } from "../auth/crypto";
import type { McpConnectionStore } from "../db/mcp-connections";
import {
  type McpOAuthClient,
  type McpCredential,
  type McpGrantBinding,
} from "../db/mcp-connections";
import type { McpServerMetadata } from "@open-inspect/shared/types/integrations";
import type { McpDestinationPolicy } from "./authorization";
import { McpError } from "./errors";

export const MCP_CREDENTIAL_TIMEOUT_MS = 20_000;
export const MCP_REFRESH_STALE_MS = 60_000;
export const MCP_TOKEN_HEADROOM_MS = 30_000;
export const MCP_OAUTH_TRANSACTION_TTL_MS = 10 * 60_000;
export type McpFetch = (request: Request) => Promise<Response>;
const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string(),
  code_challenge_methods_supported: z.array(z.string()),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string(),
  expires_in: z.number().positive().finite().optional(),
});

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new McpError("mcp_reconnect_required");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new McpError("mcp_unavailable", 503);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024) throw new McpError("mcp_unsupported");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function oauthRequest(
  fetcher: McpFetch,
  destination: McpDestinationPolicy,
  url: string,
  init: RequestInit = {}
): Promise<unknown> {
  destination(url);
  return boundedJson(
    await fetcher(
      new Request(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(MCP_CREDENTIAL_TIMEOUT_MS),
      })
    )
  );
}
async function exchange(
  fetcher: McpFetch,
  destination: McpDestinationPolicy,
  endpoint: string,
  form: URLSearchParams
): Promise<McpCredential> {
  const data = tokenSchema.parse(
    await oauthRequest(fetcher, destination, endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    })
  );
  if (data.token_type.toLowerCase() !== "bearer") throw new McpError("mcp_unsupported");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in === undefined ? null : Date.now() + data.expires_in * 1000,
  };
}

/** Only this module sees upstream OAuth tokens; routes return navigation/status, never grants. */
export class McpOAuthService {
  constructor(
    private readonly store: McpConnectionStore,
    private readonly destination: McpDestinationPolicy,
    private readonly fetcher: McpFetch = (request) => fetch(request)
  ) {}

  private assertProfile(profile: { issuer: string; resource: string; token_endpoint: string }) {
    const issuer = this.destination(profile.issuer);
    this.destination(profile.resource);
    this.destination(profile.token_endpoint, issuer.origin);
  }

  async client(server: McpServerMetadata, redirectUri: string): Promise<McpOAuthClient> {
    if (
      !server.enabled ||
      server.authMode !== "user_oauth" ||
      !server.oauth ||
      !server.managedRouting
    )
      throw new McpError("mcp_denied");
    const resource = this.destination(server.oauth.resource);
    const target = this.destination(server.url!);
    const issuer = this.destination(server.oauth.issuer);
    if (resource.href !== target.href) throw new McpError("mcp_unsupported");
    const current = await this.store.getClient(server.id);
    if (
      current &&
      current.auth_revision === server.authRevision &&
      current.redirect_uri === redirectUri
    ) {
      this.assertProfile(current);
      this.destination(current.authorization_endpoint, issuer.origin);
      return current;
    }
    const protectedMetadata = await oauthRequest(
      this.fetcher,
      this.destination,
      `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`
    );
    const protectedProfile = z
      .object({ resource: z.string(), authorization_servers: z.array(z.string()) })
      .parse(protectedMetadata);
    if (
      protectedProfile.resource !== server.oauth.resource ||
      !protectedProfile.authorization_servers.includes(server.oauth.issuer)
    )
      throw new McpError("mcp_denied");
    const metadata = metadataSchema.parse(
      await oauthRequest(
        this.fetcher,
        this.destination,
        `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname === "/" ? "" : issuer.pathname}`
      )
    );
    if (
      metadata.issuer !== server.oauth.issuer ||
      !metadata.code_challenge_methods_supported.includes("S256")
    )
      throw new McpError("mcp_denied");
    for (const endpoint of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.registration_endpoint,
    ])
      this.destination(endpoint, issuer.origin);
    const registration = z
      .object({
        client_id: z.string().min(1),
        token_endpoint_auth_method: z.literal("none"),
        redirect_uris: z.array(z.string()),
      })
      .parse(
        await oauthRequest(this.fetcher, this.destination, metadata.registration_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "Open Inspect",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        })
      );
    if (registration.redirect_uris.length !== 1 || registration.redirect_uris[0] !== redirectUri)
      throw new McpError("mcp_denied");
    const client = {
      server_id: server.id,
      auth_revision: server.authRevision!,
      issuer: server.oauth.issuer,
      resource: server.oauth.resource,
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
    };
    await this.store.saveClient(client);
    return client;
  }
  async start(
    ownerId: string,
    browserSessionId: string,
    server: McpServerMetadata,
    redirectUri: string
  ): Promise<string> {
    const client = await this.client(server, redirectUri);
    this.assertProfile(client);
    const state = generateId(32),
      verifier = generateId(32);
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    await this.store.begin(
      ownerId,
      browserSessionId,
      client,
      await hashToken(state),
      verifier,
      Date.now() + MCP_OAUTH_TRANSACTION_TTL_MS
    );
    const url = new URL(client.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uri,
      resource: client.resource,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }))
      url.searchParams.set(key, value);
    return url.toString();
  }
  async callback(
    ownerId: string,
    browserSessionId: string,
    input: { state: string; code: string; iss?: string }
  ): Promise<void> {
    const claimed = await this.store.claimTransaction(
      await hashToken(input.state),
      ownerId,
      browserSessionId,
      crypto.randomUUID(),
      Date.now()
    );
    const { connection, transaction, verifier } = claimed;
    try {
      this.assertProfile(connection);
      if (input.iss !== undefined && input.iss !== connection.issuer)
        throw new McpError("mcp_denied");
      const credential = await exchange(
        this.fetcher,
        this.destination,
        connection.token_endpoint,
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: connection.client_id,
          redirect_uri: transaction.redirect_uri,
          resource: connection.resource,
          code: input.code,
          code_verifier: verifier,
        })
      );
      this.assertProfile(connection);
      await this.store.settle(transaction, connection, credential);
    } catch (error) {
      await this.store.failTransaction(transaction).catch(() => {});
      throw error instanceof McpError ? error : new McpError("mcp_reconnect_required");
    }
  }
  async credential(binding: McpGrantBinding): Promise<string> {
    const deadline = Date.now() + MCP_CREDENTIAL_TIMEOUT_MS;
    for (;;) {
      const row = await this.store.require(binding);
      this.assertProfile(row);
      if (row.exchange_owner) {
        if (
          row.exchange_started_at === null ||
          Date.now() - row.exchange_started_at >= MCP_REFRESH_STALE_MS
        ) {
          await this.store.fenceRefresh(row, row.exchange_owner);
          throw new McpError("mcp_reconnect_required");
        }
        if (Date.now() >= deadline) throw new McpError("mcp_unavailable", 503);
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      let credential: McpCredential;
      try {
        credential = await this.store.decrypt(row);
      } catch {
        throw new McpError("mcp_reconnect_required");
      }
      if (
        credential.expiresAt === null ||
        credential.expiresAt > Date.now() + MCP_TOKEN_HEADROOM_MS
      ) {
        this.assertProfile(row);
        return credential.accessToken;
      }
      const claim = crypto.randomUUID();
      if (!(await this.store.claimRefresh(row, claim, Date.now()))) continue;
      try {
        if (!credential.refreshToken) throw new McpError("mcp_reconnect_required");
        const rotated = await exchange(
          this.fetcher,
          this.destination,
          row.token_endpoint,
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: row.client_id,
            resource: row.resource,
            refresh_token: credential.refreshToken,
          })
        );
        this.assertProfile(row);
        rotated.refreshToken ??= credential.refreshToken;
        if (!(await this.store.publishRefresh(row, claim, rotated)))
          throw new McpError("mcp_context_changed", 409);
        return rotated.accessToken;
      } catch (error) {
        await this.store.fenceRefresh(row, claim).catch(() => {});
        throw error instanceof McpError ? error : new McpError("mcp_reconnect_required");
      }
    }
  }
}
