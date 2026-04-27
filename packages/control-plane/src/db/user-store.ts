import { generateId } from "../auth/crypto";

// ── Public types ────────────────────────────────────────────────────

export interface ProviderIdentity {
  provider: "github" | "slack" | "linear";
  providerUserId: string;
  providerLogin?: string;
  providerEmail?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface ResolvedUser {
  id: string;
  displayName: string | null;
  email: string | null;
  isNew: boolean;
}

export interface User {
  id: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UserIdentity {
  id: string;
  userId: string;
  provider: string;
  providerUserId: string;
  providerLogin: string | null;
  providerEmail: string | null;
  createdAt: number;
}

export interface NewUser {
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

export interface NewUserIdentity {
  userId: string;
  provider: string;
  providerUserId: string;
  providerLogin?: string;
  providerEmail?: string;
}

export interface UserUpdate {
  displayName?: string;
  avatarUrl?: string;
  email?: string;
}

// ── Row types (D1 snake_case) ───────────────────────────────────────

interface UserRow {
  id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

interface UserIdentityRow {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  provider_login: string | null;
  provider_email: string | null;
  created_at: number;
}

// ── Row mappers ─────────────────────────────────────────────────────

function toUser(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUserIdentity(row: UserIdentityRow): UserIdentity {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    providerLogin: row.provider_login,
    providerEmail: row.provider_email,
    createdAt: row.created_at,
  };
}

// ── UserStore ───────────────────────────────────────────────────────

export class UserStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Core resolution entry point. Finds or creates a canonical user for the
   * given provider identity, with automatic email-based cross-provider linking.
   *
   * On UNIQUE constraint violation (concurrent race), retries the lookup once.
   */
  async resolveOrCreateUser(identity: ProviderIdentity): Promise<ResolvedUser> {
    try {
      return await this.doResolveOrCreate(identity);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return await this.doResolveOrCreate(identity);
      }
      throw err;
    }
  }

  async getUserById(userId: string): Promise<User | null> {
    const row = await this.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .bind(userId)
      .first<UserRow>();
    return row ? toUser(row) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const row = await this.db
      .prepare("SELECT * FROM users WHERE email = ?")
      .bind(email.toLowerCase())
      .first<UserRow>();
    return row ? toUser(row) : null;
  }

  async getIdentity(provider: string, providerUserId: string): Promise<UserIdentity | null> {
    const row = await this.db
      .prepare("SELECT * FROM user_identities WHERE provider = ? AND provider_user_id = ?")
      .bind(provider, providerUserId)
      .first<UserIdentityRow>();
    return row ? toUserIdentity(row) : null;
  }

  async getIdentitiesForUser(userId: string): Promise<UserIdentity[]> {
    const result = await this.db
      .prepare("SELECT * FROM user_identities WHERE user_id = ?")
      .bind(userId)
      .all<UserIdentityRow>();
    return (result.results ?? []).map(toUserIdentity);
  }

  async createUser(user: NewUser): Promise<User> {
    const id = generateId();
    const now = Date.now();
    const email = user.email?.toLowerCase() ?? null;

    await this.db
      .prepare(
        "INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(id, user.displayName ?? null, email, user.avatarUrl ?? null, now, now)
      .run();

    return {
      id,
      displayName: user.displayName ?? null,
      email,
      avatarUrl: user.avatarUrl ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async createIdentity(identity: NewUserIdentity): Promise<UserIdentity> {
    const id = generateId();
    const now = Date.now();
    const email = identity.providerEmail?.toLowerCase() ?? null;

    await this.db
      .prepare(
        "INSERT INTO user_identities (id, user_id, provider, provider_user_id, provider_login, provider_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        id,
        identity.userId,
        identity.provider,
        identity.providerUserId,
        identity.providerLogin ?? null,
        email,
        now
      )
      .run();

    return {
      id,
      userId: identity.userId,
      provider: identity.provider,
      providerUserId: identity.providerUserId,
      providerLogin: identity.providerLogin ?? null,
      providerEmail: email,
      createdAt: now,
    };
  }

  async updateUser(userId: string, updates: UserUpdate): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.displayName !== undefined) {
      sets.push("display_name = ?");
      values.push(updates.displayName);
    }
    if (updates.avatarUrl !== undefined) {
      sets.push("avatar_url = ?");
      values.push(updates.avatarUrl);
    }
    if (updates.email !== undefined) {
      sets.push("email = ?");
      values.push(updates.email.toLowerCase());
    }

    if (sets.length === 0) return;

    sets.push("updated_at = ?");
    values.push(Date.now());
    values.push(userId);

    await this.db
      .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  // ── Private ─────────────────────────────────────────────────────

  private async doResolveOrCreate(identity: ProviderIdentity): Promise<ResolvedUser> {
    const normalizedEmail = identity.providerEmail?.toLowerCase() ?? null;

    // Step 1: Look up by provider identity
    const existing = await this.getIdentity(identity.provider, identity.providerUserId);

    if (existing) {
      // Step 2: Existing identity → load linked user, update if needed
      const user = await this.getUserById(existing.userId);
      if (!user) {
        throw new Error(`Orphaned identity ${existing.id}: user ${existing.userId} not found`);
      }

      // Step 2a: Refresh identity-level metadata (provider_login, provider_email)
      // so getIdentity() and getIdentitiesForUser() return current values.
      await this.refreshIdentityMetadata(existing, identity.providerLogin, normalizedEmail);

      // Step 2b: User-level updates (display_name, avatar_url)
      const updates: UserUpdate = {};
      if (identity.displayName && identity.displayName !== user.displayName) {
        updates.displayName = identity.displayName;
      }
      if (identity.avatarUrl && identity.avatarUrl !== user.avatarUrl) {
        updates.avatarUrl = identity.avatarUrl;
      }

      // Step 2c: Backfill email if user has none and provider now has one.
      // The check-then-update is racy (a concurrent writer could claim the email
      // between the SELECT and UPDATE), but the outer retry in resolveOrCreateUser
      // handles this: on retry, emailOwner is non-null and we re-link instead.
      if (!user.email && normalizedEmail) {
        const emailOwner = await this.getUserByEmail(normalizedEmail);
        if (!emailOwner) {
          updates.email = normalizedEmail;
        } else if (emailOwner.id !== user.id) {
          // Another user owns this email — re-link this identity to that user.
          // This prevents permanent identity splits when e.g. a Slack identity
          // (created without email) later discovers the same email that a GitHub
          // identity already registered. Same principle as step 3 (email-based
          // cross-provider linking) but for existing identities.
          await this.db
            .prepare("UPDATE user_identities SET user_id = ? WHERE id = ?")
            .bind(emailOwner.id, existing.id)
            .run();
          return {
            id: emailOwner.id,
            displayName: emailOwner.displayName,
            email: emailOwner.email,
            isNew: false,
          };
        }
      }

      if (Object.keys(updates).length > 0) {
        await this.updateUser(user.id, updates);
      }

      return {
        id: user.id,
        displayName: updates.displayName ?? user.displayName,
        email: updates.email ?? user.email,
        isNew: false,
      };
    }

    // Step 3: No identity found — try email-based cross-provider linking
    if (normalizedEmail) {
      const emailUser = await this.getUserByEmail(normalizedEmail);
      if (emailUser) {
        await this.createIdentity({
          userId: emailUser.id,
          provider: identity.provider,
          providerUserId: identity.providerUserId,
          providerLogin: identity.providerLogin,
          providerEmail: normalizedEmail,
        });
        return {
          id: emailUser.id,
          displayName: emailUser.displayName,
          email: emailUser.email,
          isNew: false,
        };
      }
    }

    // Step 4: Brand new user — batch user + identity creation so a UNIQUE
    // failure on the identity INSERT rolls back the user INSERT, preventing
    // orphaned user rows under concurrent requests.
    const userId = generateId();
    const identityId = generateId();
    const now = Date.now();
    const displayName = identity.displayName ?? null;
    const avatarUrl = identity.avatarUrl ?? null;

    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(userId, displayName, normalizedEmail, avatarUrl, now, now),
      this.db
        .prepare(
          "INSERT INTO user_identities (id, user_id, provider, provider_user_id, provider_login, provider_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          identityId,
          userId,
          identity.provider,
          identity.providerUserId,
          identity.providerLogin ?? null,
          normalizedEmail,
          now
        ),
    ]);

    return {
      id: userId,
      displayName,
      email: normalizedEmail,
      isNew: true,
    };
  }

  /**
   * Update identity-level metadata (provider_login, provider_email) if
   * the provider now reports newer values than what's stored. This keeps
   * getIdentity() and getIdentitiesForUser() accurate across repeat sign-ins.
   */
  private async refreshIdentityMetadata(
    existing: UserIdentity,
    providerLogin: string | undefined,
    normalizedEmail: string | null
  ): Promise<void> {
    const sets: string[] = [];
    const values: (string | null)[] = [];

    if (providerLogin && providerLogin !== existing.providerLogin) {
      sets.push("provider_login = ?");
      values.push(providerLogin);
    }
    if (normalizedEmail && normalizedEmail !== existing.providerEmail) {
      sets.push("provider_email = ?");
      values.push(normalizedEmail);
    }

    if (sets.length === 0) return;

    values.push(existing.id);
    await this.db
      .prepare(`UPDATE user_identities SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes("unique constraint failed");
}
