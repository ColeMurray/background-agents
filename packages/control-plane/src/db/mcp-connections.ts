import { z } from "zod";
import type { SqlDatabase } from "./sql-database";
import { encryptMcp, decryptMcp } from "../mcp/crypto";
import { McpError } from "../mcp/errors";

export interface McpOAuthClient {
  server_id: string;
  auth_revision: number;
  issuer: string;
  resource: string;
  client_id: string;
  redirect_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
}
export interface McpConnectionRow {
  id: string;
  owner_id: string;
  server_id: string;
  auth_revision: number;
  issuer: string;
  resource: string;
  client_id: string;
  token_endpoint: string;
  status: "connected" | "disconnected" | "reconnect_required";
  grant_revision: number;
  credential_version: number;
  encrypted_payload: string | null;
  expires_at: number | null;
  exchange_owner: string | null;
  exchange_started_at: number | null;
  updated_at: number;
}
export interface McpOAuthTransaction {
  state_digest: string;
  owner_id: string;
  browser_session_id: string;
  connection_id: string;
  grant_revision: number;
  auth_revision: number;
  redirect_uri: string;
  encrypted_verifier: string;
  expires_at: number;
  status: "pending" | "claimed" | "settled" | "invalidated";
  claim_owner: string | null;
}
const credentialSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().finite().nullable(),
});
export type McpCredential = z.infer<typeof credentialSchema>;
export interface McpGrantBinding {
  connectionId: string;
  grantRevision: number;
  serverId: string;
  serverAuthRevision: number;
  canonicalUserId: string;
}

export function connectionBinding(row: McpConnectionRow): McpGrantBinding {
  return {
    connectionId: row.id,
    grantRevision: row.grant_revision,
    serverId: row.server_id,
    serverAuthRevision: row.auth_revision,
    canonicalUserId: row.owner_id,
  };
}
function aad(row: McpConnectionRow) {
  return [
    "mcp-grant",
    1,
    row.id,
    row.owner_id,
    row.server_id,
    row.auth_revision,
    row.issuer,
    row.resource,
    row.client_id,
    row.grant_revision,
  ];
}
function transactionAad(
  row: Omit<McpOAuthTransaction, "encrypted_verifier" | "status" | "claim_owner">
) {
  return [
    "mcp-oauth",
    1,
    row.state_digest,
    row.owner_id,
    row.browser_session_id,
    row.connection_id,
    row.grant_revision,
    row.auth_revision,
    row.redirect_uri,
  ];
}

/** Durable conditional writes, shared across sessions/isolates; no process-local lock. */
export class McpConnectionStore {
  constructor(
    readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  get(ownerId: string, serverId: string) {
    return this.db
      .prepare("SELECT * FROM mcp_connections WHERE owner_id = ? AND server_id = ?")
      .bind(ownerId, serverId)
      .first<McpConnectionRow>();
  }
  async require(binding: McpGrantBinding): Promise<McpConnectionRow> {
    const row = await this.db
      .prepare(
        `SELECT c.*, s.auth_revision AS server_auth_revision, s.enabled AS server_enabled
        FROM mcp_connections c JOIN mcp_servers s ON s.id = c.server_id
        WHERE c.owner_id = ? AND c.server_id = ?`
      )
      .bind(binding.canonicalUserId, binding.serverId)
      .first<McpConnectionRow & { server_auth_revision: number; server_enabled: number }>();
    if (!row) throw new McpError("mcp_connection_required");
    if (
      row.id !== binding.connectionId ||
      row.grant_revision !== binding.grantRevision ||
      row.auth_revision !== binding.serverAuthRevision ||
      row.auth_revision !== row.server_auth_revision ||
      row.server_enabled !== 1
    )
      throw new McpError("mcp_context_changed", 409);
    if (row.status === "disconnected") throw new McpError("mcp_disconnected");
    if (row.status !== "connected") throw new McpError("mcp_reconnect_required");
    return row;
  }
  getClient(serverId: string) {
    return this.db
      .prepare("SELECT * FROM mcp_oauth_clients WHERE server_id = ?")
      .bind(serverId)
      .first<McpOAuthClient>();
  }
  async saveClient(client: McpOAuthClient): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO mcp_oauth_clients (server_id, auth_revision, issuer, resource, client_id, redirect_uri, authorization_endpoint, token_endpoint)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM mcp_servers WHERE id = ? AND auth_revision = ? AND enabled = 1)
      ON CONFLICT(server_id) DO UPDATE SET auth_revision = excluded.auth_revision, issuer = excluded.issuer, resource = excluded.resource, client_id = excluded.client_id,
      redirect_uri = excluded.redirect_uri, authorization_endpoint = excluded.authorization_endpoint, token_endpoint = excluded.token_endpoint`
      )
      .bind(
        client.server_id,
        client.auth_revision,
        client.issuer,
        client.resource,
        client.client_id,
        client.redirect_uri,
        client.authorization_endpoint,
        client.token_endpoint,
        client.server_id,
        client.auth_revision
      )
      .run();
  }
  async begin(
    ownerId: string,
    browserSessionId: string,
    client: McpOAuthClient,
    stateDigest: string,
    verifier: string,
    expiresAt: number
  ): Promise<void> {
    await this.pruneTransactions(ownerId);
    // Reserve canonical ownership before encryption/transaction publication can
    // yield. Disconnected would let identity writers bypass the database guards
    // in that gap, and hide the owner's cancellation action after abandoned consent.
    const row = await this.db
      .prepare(
        `INSERT INTO mcp_connections (id, owner_id, server_id, auth_revision, issuer, resource, client_id, token_endpoint, status, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'reconnect_required', ? WHERE EXISTS (SELECT 1 FROM mcp_servers WHERE id = ? AND auth_revision = ? AND enabled = 1)
      ON CONFLICT(owner_id, server_id) DO UPDATE SET auth_revision = excluded.auth_revision, issuer = excluded.issuer, resource = excluded.resource,
      client_id = excluded.client_id, token_endpoint = excluded.token_endpoint, status = 'reconnect_required', grant_revision = mcp_connections.grant_revision + 1,
      encrypted_payload = NULL, expires_at = NULL, exchange_owner = NULL, exchange_started_at = NULL, updated_at = excluded.updated_at RETURNING *`
      )
      .bind(
        crypto.randomUUID(),
        ownerId,
        client.server_id,
        client.auth_revision,
        client.issuer,
        client.resource,
        client.client_id,
        client.token_endpoint,
        Date.now(),
        client.server_id,
        client.auth_revision
      )
      .first<McpConnectionRow>();
    if (!row) throw new McpError("mcp_context_changed", 409);
    const transaction = {
      state_digest: stateDigest,
      owner_id: ownerId,
      browser_session_id: browserSessionId,
      connection_id: row.id,
      grant_revision: row.grant_revision,
      auth_revision: row.auth_revision,
      redirect_uri: client.redirect_uri,
      expires_at: expiresAt,
    };
    const encrypted = await encryptMcp(verifier, this.encryptionKey, transactionAad(transaction));
    const results = await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM mcp_oauth_transactions WHERE connection_id = ? AND grant_revision <= ?"
        )
        .bind(row.id, row.grant_revision),
      this.db
        .prepare(
          `INSERT INTO mcp_oauth_transactions (state_digest, owner_id, browser_session_id, connection_id, grant_revision, auth_revision, redirect_uri, encrypted_verifier, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM mcp_connections WHERE id = ? AND grant_revision = ?)`
        )
        .bind(
          stateDigest,
          ownerId,
          browserSessionId,
          row.id,
          row.grant_revision,
          row.auth_revision,
          client.redirect_uri,
          encrypted,
          expiresAt,
          row.id,
          row.grant_revision
        ),
    ]);
    if (results[1].meta.changes !== 1) throw new McpError("mcp_context_changed", 409);
  }
  /** Lazy cleanup also reclaims history written before consent became single-attempt. */
  async pruneTransactions(ownerId: string, now = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM mcp_oauth_transactions WHERE owner_id = ? AND (
          status NOT IN ('pending', 'claimed') OR expires_at <= ?
          OR NOT EXISTS (SELECT 1 FROM auth_sessions a WHERE a.id = browser_session_id AND a.userId = owner_id AND a.expiresAt > ?)
          OR NOT EXISTS (SELECT 1 FROM mcp_connections c WHERE c.id = connection_id AND c.grant_revision = mcp_oauth_transactions.grant_revision)
        )`
      )
      .bind(ownerId, now, now)
      .run();
  }
  async claimTransaction(
    stateDigest: string,
    ownerId: string,
    sessionId: string,
    claim: string,
    now: number
  ) {
    await this.pruneTransactions(ownerId, now);
    const transaction = await this.db
      .prepare(
        `UPDATE mcp_oauth_transactions SET status = 'claimed', claim_owner = ?
      WHERE state_digest = ? AND owner_id = ? AND browser_session_id = ? AND status = 'pending' AND expires_at > ?
      AND EXISTS (SELECT 1 FROM auth_sessions a JOIN users u ON u.id = a.userId WHERE a.id = browser_session_id AND a.userId = owner_id AND a.expiresAt > ? AND u.suspended_at IS NULL)
      AND EXISTS (SELECT 1 FROM mcp_connections c JOIN mcp_servers s ON s.id = c.server_id WHERE c.id = connection_id
        AND c.grant_revision = mcp_oauth_transactions.grant_revision AND c.auth_revision = s.auth_revision AND s.enabled = 1)
      RETURNING *`
      )
      .bind(claim, stateDigest, ownerId, sessionId, now, now)
      .first<McpOAuthTransaction>();
    if (!transaction) throw new McpError("mcp_denied");
    const connection = await this.db
      .prepare("SELECT * FROM mcp_connections WHERE id = ? AND owner_id = ? AND grant_revision = ?")
      .bind(transaction.connection_id, ownerId, transaction.grant_revision)
      .first<McpConnectionRow>();
    if (!connection) throw new McpError("mcp_context_changed", 409);
    return {
      transaction,
      connection,
      verifier: await decryptMcp<string>(
        transaction.encrypted_verifier,
        this.encryptionKey,
        transactionAad(transaction)
      ),
    };
  }
  async settle(
    transaction: McpOAuthTransaction,
    connection: McpConnectionRow,
    credential: McpCredential
  ): Promise<void> {
    const encrypted = await encryptMcp(credential, this.encryptionKey, aad(connection));
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE mcp_connections SET status = 'connected', encrypted_payload = ?, expires_at = ?, credential_version = credential_version + 1, updated_at = ?
        WHERE id = ? AND owner_id = ? AND grant_revision = ? AND auth_revision = ?
        AND EXISTS (SELECT 1 FROM mcp_oauth_transactions t WHERE t.state_digest = ? AND t.status = 'claimed' AND t.claim_owner = ? AND t.expires_at > ?
          AND EXISTS (SELECT 1 FROM auth_sessions a JOIN users u ON u.id = a.userId WHERE a.id = t.browser_session_id AND a.userId = t.owner_id AND a.expiresAt > ? AND u.suspended_at IS NULL))
        AND EXISTS (SELECT 1 FROM mcp_servers s WHERE s.id = server_id AND s.auth_revision = mcp_connections.auth_revision AND s.enabled = 1)`
        )
        .bind(
          encrypted,
          credential.expiresAt,
          Date.now(),
          connection.id,
          connection.owner_id,
          connection.grant_revision,
          connection.auth_revision,
          transaction.state_digest,
          transaction.claim_owner,
          Date.now(),
          Date.now()
        ),
      this.db
        .prepare(
          "DELETE FROM mcp_oauth_transactions WHERE state_digest = ? AND status = 'claimed' AND claim_owner = ?"
        )
        .bind(transaction.state_digest, transaction.claim_owner),
    ]);
    if (results[0].meta.changes !== 1) throw new McpError("mcp_context_changed", 409);
  }
  async disconnect(ownerId: string, serverId: string): Promise<void> {
    await this.disconnectMatching(serverId, ownerId);
  }
  /** Administrative revocation is restricted to disabled definitions in the same transaction. */
  async disconnectServer(serverId: string): Promise<void> {
    await this.disconnectMatching(serverId, null);
  }
  private async disconnectMatching(serverId: string, ownerId: string | null): Promise<void> {
    const results = await this.db.batch<{ enabled: number }>([
      this.db.prepare("SELECT enabled FROM mcp_servers WHERE id = ?").bind(serverId),
      this.db
        .prepare(
          `DELETE FROM mcp_oauth_transactions WHERE connection_id IN (
            SELECT id FROM mcp_connections WHERE server_id = ? AND (? IS NULL OR owner_id = ?)
            AND (? IS NOT NULL OR EXISTS (SELECT 1 FROM mcp_servers s WHERE s.id = server_id AND s.enabled = 0)))`
        )
        .bind(serverId, ownerId, ownerId, ownerId),
      this.db
        .prepare(
          `UPDATE mcp_connections SET status = 'disconnected', grant_revision = grant_revision + 1, encrypted_payload = NULL,
        expires_at = NULL, exchange_owner = NULL, exchange_started_at = NULL, updated_at = ?
        WHERE server_id = ? AND (? IS NULL OR owner_id = ?)
        AND (? IS NOT NULL OR EXISTS (SELECT 1 FROM mcp_servers s WHERE s.id = server_id AND s.enabled = 0))`
        )
        .bind(Date.now(), serverId, ownerId, ownerId, ownerId),
    ]);
    if (ownerId === null) {
      const server = results[0].results[0];
      if (!server) throw new McpError("mcp_denied", 404);
      if (server.enabled !== 0) throw new McpError("mcp_context_changed", 409);
    }
  }
  async failTransaction(transaction: McpOAuthTransaction): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM mcp_oauth_transactions WHERE state_digest = ? AND status = 'claimed' AND claim_owner = ?"
      )
      .bind(transaction.state_digest, transaction.claim_owner)
      .run();
  }
  async decrypt(row: McpConnectionRow): Promise<McpCredential> {
    if (!row.encrypted_payload) throw new McpError("mcp_reconnect_required");
    return credentialSchema.parse(
      await decryptMcp<unknown>(row.encrypted_payload, this.encryptionKey, aad(row))
    );
  }
  async claimRefresh(row: McpConnectionRow, claim: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE mcp_connections SET exchange_owner = ?, exchange_started_at = ?
      WHERE id = ? AND grant_revision = ? AND credential_version = ? AND status = 'connected' AND exchange_owner IS NULL`
      )
      .bind(claim, now, row.id, row.grant_revision, row.credential_version)
      .run();
    return result.meta.changes === 1;
  }
  async publishRefresh(
    row: McpConnectionRow,
    claim: string,
    credential: McpCredential
  ): Promise<boolean> {
    const encrypted = await encryptMcp(credential, this.encryptionKey, aad(row));
    const result = await this.db
      .prepare(
        `UPDATE mcp_connections SET encrypted_payload = ?, expires_at = ?, credential_version = credential_version + 1,
      exchange_owner = NULL, exchange_started_at = NULL, updated_at = ? WHERE id = ? AND grant_revision = ? AND credential_version = ?
      AND exchange_owner = ? AND status = 'connected'
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = owner_id AND u.suspended_at IS NULL)
      AND EXISTS (SELECT 1 FROM mcp_servers s WHERE s.id = server_id AND s.auth_revision = mcp_connections.auth_revision AND s.enabled = 1)`
      )
      .bind(
        encrypted,
        credential.expiresAt,
        Date.now(),
        row.id,
        row.grant_revision,
        row.credential_version,
        claim
      )
      .run();
    return result.meta.changes === 1;
  }
  async fenceRefresh(row: McpConnectionRow, claim: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE mcp_connections SET status = 'reconnect_required', exchange_owner = NULL, exchange_started_at = NULL, updated_at = ?
      WHERE id = ? AND grant_revision = ? AND credential_version = ? AND exchange_owner = ? AND status = 'connected'`
      )
      .bind(Date.now(), row.id, row.grant_revision, row.credential_version, claim)
      .run();
  }
}
