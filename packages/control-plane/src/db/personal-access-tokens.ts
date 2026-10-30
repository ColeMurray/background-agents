/**
 * Storage for personal access tokens and their permission grants.
 *
 * The plaintext token is returned exactly once, by `issue`. Everything persisted here is either a
 * hash or non-secret metadata, so this store can be read in full without yielding a usable
 * credential. Issue and revoke write their audit event in the same transaction as the change.
 */

import {
  isRegisteredPermission,
  PERMISSION_IDS,
  type PermissionId,
} from "@open-inspect/shared/rbac";
import type { AuditOperationAction } from "@open-inspect/shared/types/audit-events";
import {
  PERSONAL_ACCESS_TOKEN_MAX_PER_USER,
  PERSONAL_ACCESS_TOKEN_PREFIX,
  PERSONAL_ACCESS_TOKEN_RANDOM_BYTES,
  type CreatedPersonalAccessToken,
  type PersonalAccessToken,
  type WorkspacePersonalAccessToken,
} from "@open-inspect/shared/types/personal-access-tokens";
import { generateId, hashToken } from "../auth/crypto";
import { personalAccessTokenDisplayPrefix } from "../auth/personal-access-token";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/**
 * How coarsely `last_used_at` is tracked. It answers "is this token still in use?", so minute
 * resolution is ample and spares every authenticated request a row write.
 */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** What authentication needs from a presented token's row. */
export interface PersonalAccessTokenCredential {
  readonly id: string;
  readonly userId: string;
  readonly displayPrefix: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Registered permissions only; a grant naming a since-removed permission ignores it. */
  readonly grant: readonly PermissionId[];
}

export interface IssuePersonalAccessTokenInput {
  readonly userId: string;
  readonly name: string;
  readonly permissions: readonly PermissionId[];
  readonly expiresAt: number;
  readonly now: number;
  readonly requestId: string;
}

export type IssuePersonalAccessTokenResult =
  { kind: "issued"; token: CreatedPersonalAccessToken } | { kind: "limit_reached" };

export interface RevokePersonalAccessTokenInput {
  /** The token's owner; a token id alone never selects another user's token. */
  readonly userId: string;
  readonly tokenId: string;
  /** Who revoked it: the owner, or an administrator acting on the owner's token. */
  readonly actorUserId: string;
  readonly now: number;
  readonly requestId: string;
}

interface TokenRow {
  id: string;
  name: string;
  display_prefix: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
}

interface WorkspaceTokenRow extends TokenRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
}

/** A page position in the workspace listing: the last row's creation time and id. */
function encodeCursor(row: { created_at: number; id: string }): string {
  return `${row.created_at}:${row.id}`;
}

function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  const match = /^(\d+):([0-9a-f]+)$/.exec(cursor);
  return match ? { createdAt: Number(match[1]), id: match[2] } : null;
}

interface GrantRow {
  token_id: string;
  permission_id: string;
}

/** Registered permissions in registry order, so a grant reads the same however it was stored. */
function canonicalGrant(permissions: Iterable<string>): PermissionId[] {
  const named = new Set(permissions);
  return PERMISSION_IDS.filter((permission) => named.has(permission));
}

function grantsByToken(rows: readonly GrantRow[]): Map<string, PermissionId[]> {
  const raw = new Map<string, string[]>();
  for (const row of rows) {
    const permissions = raw.get(row.token_id) ?? [];
    permissions.push(row.permission_id);
    raw.set(row.token_id, permissions);
  }
  return new Map([...raw].map(([tokenId, permissions]) => [tokenId, canonicalGrant(permissions)]));
}

function toPersonalAccessToken(row: TokenRow, permissions: PermissionId[]): PersonalAccessToken {
  return {
    id: row.id,
    name: row.name,
    displayPrefix: row.display_prefix,
    permissions,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}

/** The audit snapshot of a token: everything but its secret and usage. */
function auditSnapshot(token: PersonalAccessToken) {
  return {
    name: token.name,
    displayPrefix: token.displayPrefix,
    permissions: token.permissions,
    expiresAt: token.expiresAt,
  };
}

export class PersonalAccessTokenStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Issues a token unless its owner already holds PERSONAL_ACCESS_TOKEN_MAX_PER_USER. The limit,
   * the token, its grant, and its audit event commit together or not at all.
   */
  async issue(input: IssuePersonalAccessTokenInput): Promise<IssuePersonalAccessTokenResult> {
    const plaintext = `${PERSONAL_ACCESS_TOKEN_PREFIX}${generateId(PERSONAL_ACCESS_TOKEN_RANDOM_BYTES)}`;
    const token: CreatedPersonalAccessToken = {
      id: generateId(),
      name: input.name,
      displayPrefix: personalAccessTokenDisplayPrefix(plaintext),
      permissions: canonicalGrant(input.permissions),
      createdAt: input.now,
      lastUsedAt: null,
      expiresAt: input.expiresAt,
      token: plaintext,
    };

    const [inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO personal_access_tokens
             (id, user_id, name, token_hash, display_prefix, created_at, last_used_at, expires_at)
           SELECT ?, ?, ?, ?, ?, ?, NULL, ?
           WHERE (SELECT COUNT(*) FROM personal_access_tokens WHERE user_id = ?) < ?`
        )
        .bind(
          token.id,
          input.userId,
          token.name,
          await hashToken(plaintext),
          token.displayPrefix,
          token.createdAt,
          token.expiresAt,
          input.userId,
          PERSONAL_ACCESS_TOKEN_MAX_PER_USER
        ),
      ...token.permissions.map((permission) =>
        this.db
          .prepare(
            `INSERT INTO personal_access_token_permissions (token_id, permission_id)
             SELECT ?, ? WHERE EXISTS (SELECT 1 FROM personal_access_tokens WHERE id = ?)`
          )
          .bind(token.id, permission, token.id)
      ),
      this.bindAudit({
        action: "personal_access_token.created",
        tokenId: token.id,
        ownerUserId: input.userId,
        actorUserId: input.userId,
        requestId: input.requestId,
        now: input.now,
        before: {},
        after: auditSnapshot(token),
      }),
    ]);
    if (inserted.meta.changes === 0) return { kind: "limit_reached" };
    return { kind: "issued", token };
  }

  /** One user's tokens, newest first, with their grants. Never includes a secret. */
  async list(userId: string): Promise<PersonalAccessToken[]> {
    const [tokens, grants] = await this.db.batch([
      this.db
        .prepare(
          `SELECT id, name, display_prefix, created_at, last_used_at, expires_at
             FROM personal_access_tokens
            WHERE user_id = ?
            ORDER BY created_at DESC, id`
        )
        .bind(userId),
      this.db
        .prepare(
          `SELECT grant_row.token_id, grant_row.permission_id
             FROM personal_access_token_permissions grant_row
             JOIN personal_access_tokens token ON token.id = grant_row.token_id
            WHERE token.user_id = ?`
        )
        .bind(userId),
    ]);
    const grantsById = grantsByToken(grants.results as GrantRow[]);
    return (tokens.results as TokenRow[]).map((row) =>
      toPersonalAccessToken(row, grantsById.get(row.id) ?? [])
    );
  }

  /**
   * Every token in the workspace with its owner, newest first, for administrators. Pages by
   * keyset, so a revocation between pages neither repeats nor skips a token.
   */
  async listAll(options: {
    limit: number;
    cursor?: string;
  }): Promise<{ tokens: WorkspacePersonalAccessToken[]; nextCursor: string | null } | null> {
    const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    if (after === null) return null;
    const { results } = await this.db
      .prepare(
        `SELECT token.id, token.user_id, token.name, token.display_prefix, token.created_at,
                token.last_used_at, token.expires_at, users.display_name, users.email
           FROM personal_access_tokens token
           JOIN users ON users.id = token.user_id
          WHERE ? IS NULL OR token.created_at < ? OR (token.created_at = ? AND token.id > ?)
          ORDER BY token.created_at DESC, token.id
          LIMIT ?`
      )
      .bind(
        after?.createdAt ?? null,
        after?.createdAt ?? null,
        after?.createdAt ?? null,
        after?.id ?? null,
        options.limit + 1
      )
      .all<WorkspaceTokenRow>();
    const page = results.slice(0, options.limit);
    const grants =
      page.length === 0
        ? new Map<string, PermissionId[]>()
        : grantsByToken(
            (
              await this.db
                .prepare(
                  `SELECT token_id, permission_id FROM personal_access_token_permissions
                    WHERE token_id IN (${page.map(() => "?").join(", ")})`
                )
                .bind(...page.map((row) => row.id))
                .all<GrantRow>()
            ).results
          );
    return {
      tokens: page.map((row) => ({
        ...toPersonalAccessToken(row, grants.get(row.id) ?? []),
        owner: { userId: row.user_id, displayName: row.display_name, email: row.email },
      })),
      nextCursor: results.length > options.limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  /** Whose token this is, or null when there is no such token. */
  async ownerOf(tokenId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT user_id FROM personal_access_tokens WHERE id = ?")
      .bind(tokenId)
      .first<{ user_id: string }>();
    return row?.user_id ?? null;
  }

  /**
   * Revokes every token `userId` holds, recording each revocation and who made it. Returns how
   * many were revoked; a token issued after the read is not among them.
   */
  async revokeAll(input: Omit<RevokePersonalAccessTokenInput, "tokenId">): Promise<number> {
    const tokens = await this.list(input.userId);
    if (tokens.length === 0) return 0;
    const results = await this.db.batch([
      ...tokens.map((token) =>
        this.bindAudit({
          action: "personal_access_token.revoked",
          tokenId: token.id,
          ownerUserId: input.userId,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          now: input.now,
          before: auditSnapshot(token),
          after: {},
        })
      ),
      this.db
        .prepare(
          `DELETE FROM personal_access_tokens
            WHERE user_id = ? AND id IN (${tokens.map(() => "?").join(", ")})
            RETURNING id`
        )
        .bind(input.userId, ...tokens.map((token) => token.id)),
    ]);
    // Counted from the returned rows: an engine may include the cascaded grant rows in `changes`.
    return results[results.length - 1].results.length;
  }

  /**
   * Revokes one of `userId`'s tokens and records who did it. Returns the revoked token, or null
   * when `userId` holds no token with that id (including one a concurrent request just revoked).
   */
  async revoke(input: RevokePersonalAccessTokenInput): Promise<PersonalAccessToken | null> {
    const existing = (await this.list(input.userId)).find((token) => token.id === input.tokenId);
    if (!existing) return null;
    const [, deleted] = await this.db.batch([
      this.bindAudit({
        action: "personal_access_token.revoked",
        tokenId: input.tokenId,
        ownerUserId: input.userId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        now: input.now,
        before: auditSnapshot(existing),
        after: {},
      }),
      this.db
        .prepare("DELETE FROM personal_access_tokens WHERE id = ? AND user_id = ?")
        .bind(input.tokenId, input.userId),
    ]);
    return deleted.meta.changes > 0 ? existing : null;
  }

  /**
   * Resolves a presented token by its hash, with its grant. Expiry is not filtered here: the
   * caller decides, so both outcomes stay visible to it.
   */
  async findByToken(token: string): Promise<PersonalAccessTokenCredential | null> {
    const { results } = await this.db
      .prepare(
        `SELECT token.id, token.user_id, token.display_prefix, token.created_at, token.expires_at,
                grant_row.permission_id
           FROM personal_access_tokens token
           LEFT JOIN personal_access_token_permissions grant_row ON grant_row.token_id = token.id
          WHERE token.token_hash = ?`
      )
      .bind(await hashToken(token))
      .all<{
        id: string;
        user_id: string;
        display_prefix: string;
        created_at: number;
        expires_at: number;
        permission_id: string | null;
      }>();
    const row = results[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      displayPrefix: row.display_prefix,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      grant: canonicalGrant(
        results.flatMap(({ permission_id }) =>
          permission_id !== null && isRegisteredPermission(permission_id) ? [permission_id] : []
        )
      ),
    };
  }

  /**
   * Records use, at most once per LAST_USED_RESOLUTION_MS. The guard is in the statement rather
   * than a read-then-write, so the common case costs one round trip and concurrent requests
   * cannot both decide to write.
   */
  async touchLastUsed(tokenId: string, at: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE personal_access_tokens
            SET last_used_at = ?
          WHERE id = ?
            AND (last_used_at IS NULL OR last_used_at < ?)`
      )
      .bind(at, tokenId, at - LAST_USED_RESOLUTION_MS)
      .run();
  }

  /**
   * The audit row for a token operation, written only while the token exists: after the insert
   * that issues it, and before the delete that revokes it, in the same batch.
   */
  private bindAudit(event: {
    action: Extract<AuditOperationAction, `personal_access_token.${string}`>;
    tokenId: string;
    ownerUserId: string;
    actorUserId: string;
    requestId: string;
    now: number;
    before: object;
    after: object;
  }): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO authorization_audit_events
           (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
            action, resource_type, resource_id, target_user_id_snapshot, team_id,
            reason_code, operation_result, metadata_json)
         SELECT ?, ?, ?, 'user', ?, ?, 'personal_access_token', ?, ?, NULL, ?, 'applied', ?
         WHERE EXISTS (SELECT 1 FROM personal_access_tokens WHERE id = ? AND user_id = ?)`
      )
      .bind(
        crypto.randomUUID(),
        event.now,
        event.requestId,
        event.actorUserId,
        event.action,
        event.tokenId,
        event.ownerUserId,
        event.action,
        JSON.stringify({ before: event.before, requested: {}, after: event.after }),
        event.tokenId,
        event.ownerUserId
      );
  }
}
