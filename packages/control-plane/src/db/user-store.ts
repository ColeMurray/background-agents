import { z } from "zod";
import { getSignInProviderIssuer } from "@open-inspect/shared/sign-in-provider";
import {
  sessionCollaboratorCandidatesResponseSchema,
  type SessionCollaboratorCandidate,
} from "@open-inspect/shared/types/sessions";
import { generateId } from "../auth/crypto";
import { normalizeEmail } from "./email";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase } from "./sql-database";

// ── Public types ────────────────────────────────────────────────────

export interface ProviderIdentity {
  provider: "github" | "slack" | "linear" | "google";
  providerUserId: string;
  providerLogin?: string;
  providerEmail?: string;
  displayName?: string;
  avatarUrl?: string;
}

export type EnrollmentAdmission = (identity: Readonly<ProviderIdentity>) => void | Promise<void>;

/**
 * Ingress providers whose attributed emails are platform-verified mailboxes
 * fetched server-side by first-party bots: Slack confirms every address at
 * signup and on change, and Linear's email is its login credential. Emails
 * written from these providers carry verification (`email_verified = 1`) —
 * the same weight as a completed OAuth sign-in proof, and what admits the
 * user through Better Auth's implicit-linking gate at their first web
 * sign-in. Every other provider's attribution stays unproven until the
 * sign-in claim mints proof; a new ingress provider must be added here
 * deliberately, never by default.
 */
const EMAIL_ATTESTING_PROVIDERS: ReadonlySet<ProviderIdentity["provider"]> = new Set([
  "slack",
  "linear",
]);

export function isEmailAttestingProvider(provider: ProviderIdentity["provider"]): boolean {
  return EMAIL_ATTESTING_PROVIDERS.has(provider);
}

/**
 * Ingress providers whose unknown actors are enrolled only with an attested
 * email. An actor links to an existing user by email only at enrollment and
 * is never relinked, and every new user gets the default role, so an
 * email-less enrollment would give someone a second account free of the
 * suspension or role restrictions on their existing one.
 *
 * Known limitation: a Slack user whose profile email the bot cannot read,
 * typically an external Slack Connect user, cannot be enrolled and so cannot
 * use the bot. Linear's catalog reads are actorless; its session-creation
 * request carries the enrolling actor's email.
 */
const ENROLLMENT_EMAIL_REQUIRED_PROVIDERS: ReadonlySet<ProviderIdentity["provider"]> = new Set([
  "slack",
  "linear",
]);

export function requiresEnrollmentEmail(provider: ProviderIdentity["provider"]): boolean {
  return ENROLLMENT_EMAIL_REQUIRED_PROVIDERS.has(provider);
}

export type ResolveUserOutcome = "existing" | "linked" | "created";

export interface ResolvedUser {
  id: string;
  displayName: string | null;
  email: string | null;
  outcome: ResolveUserOutcome;
}

export interface User {
  id: string;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
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
  providerIssuer: string | null;
  createdAt: number;
}

export interface NewUser {
  displayName?: string;
  email?: string;
  /** Whether `email` comes with mailbox-ownership proof (attesting provider). */
  emailVerified?: boolean;
  avatarUrl?: string;
}

export interface NewUserIdentity {
  userId: string;
  provider: string;
  providerUserId: string;
  providerLogin?: string;
  providerEmail?: string;
}

// ── Row types (D1 snake_case) ───────────────────────────────────────

interface UserRow {
  id: string;
  display_name: string | null;
  email: string | null;
  email_verified: number;
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
  provider_issuer: string | null;
  created_at: number;
}

// ── Row mappers ─────────────────────────────────────────────────────

function toUser(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    emailVerified: row.email_verified === 1,
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
    providerIssuer: row.provider_issuer,
    createdAt: row.created_at,
  };
}

export type CollaboratorEligibility = "eligible" | "not_found" | "inactive" | "not_team_member";

const collaboratorEligibilityRowSchema = z.object({
  suspended_at: z.number().nullable(),
  role_id: z.string().nullable(),
  team_member: z.number(),
});

// ── UserStore ───────────────────────────────────────────────────────

export class UserStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Lists active users; a team ID restricts candidates to that team's members. */
  async listCollaboratorCandidates({
    includeEmail,
    teamId = null,
  }: {
    includeEmail: boolean;
    teamId?: string | null;
  }): Promise<SessionCollaboratorCandidate[]> {
    const { results } = await this.db
      .prepare(
        `SELECT users.id AS userId, users.display_name AS displayName,
                ${includeEmail ? "users.email" : "NULL AS email"}, users.avatar_url AS avatarUrl
         FROM users
         JOIN user_role_assignments assignment ON assignment.user_id = users.id
         ${teamId === null ? "" : "JOIN team_memberships m ON m.user_id = users.id AND m.team_id = ?"}
         WHERE users.suspended_at IS NULL AND assignment.role_id IS NOT NULL
         ORDER BY LOWER(COALESCE(users.display_name, ${includeEmail ? "users.email" : "NULL"}, users.id)), users.id`
      )
      .bind(...(teamId === null ? [] : [teamId]))
      .all();
    return sessionCollaboratorCandidatesResponseSchema.parse(results);
  }

  /** Applies the candidate-list rules to one user; a team ID also requires membership in that team. */
  async getCollaboratorEligibility(
    userId: string,
    teamId: string | null
  ): Promise<CollaboratorEligibility> {
    const row = collaboratorEligibilityRowSchema.nullable().parse(
      await this.db
        .prepare(
          `SELECT users.suspended_at, assignment.role_id,
                  EXISTS (SELECT 1 FROM team_memberships m
                          WHERE m.team_id = ? AND m.user_id = users.id) AS team_member
           FROM users
           LEFT JOIN user_role_assignments assignment ON assignment.user_id = users.id
           WHERE users.id = ?`
        )
        .bind(teamId, userId)
        .first()
    );
    if (!row) return "not_found";
    if (row.suspended_at !== null || row.role_id === null) return "inactive";
    if (teamId !== null && !row.team_member) return "not_team_member";
    return "eligible";
  }

  async getUsersByIds(userIds: readonly string[]): Promise<User[]> {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length === 0) return [];

    const statements = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 100) {
      const ids = uniqueIds.slice(offset, offset + 100);
      statements.push(
        this.db
          .prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => "?").join(", ")})`)
          .bind(...ids)
      );
    }
    const results = await this.db.batch<UserRow>(statements);
    return results.flatMap((result) => result.results.map(toUser));
  }

  /**
   * Core resolution entry point. Finds or creates a canonical user for the
   * given provider identity, with automatic email-based cross-provider linking.
   * Admission receives the normalized identity before a new user is inserted;
   * existing identities and email links retain their existing account access.
   *
   * On UNIQUE constraint violation (concurrent race), retries the lookup once.
   */
  async resolveOrCreateUser(
    identity: ProviderIdentity,
    requireEnrollmentAdmission: EnrollmentAdmission
  ): Promise<ResolvedUser> {
    try {
      return await this.doResolveOrCreate(identity, requireEnrollmentAdmission);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return await this.doResolveOrCreate(identity, requireEnrollmentAdmission);
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
      .bind(normalizeEmail(email))
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
    // ORDER BY created_at gives a deterministic order so callers that pick a
    // single identity (e.g. resolveGitHubEnrichment) get a stable result.
    // Google's email-based cross-provider linking makes multi-identity users
    // more common, so the previously-unordered query could otherwise vary.
    const result = await this.db
      .prepare("SELECT * FROM user_identities WHERE user_id = ? ORDER BY created_at ASC")
      .bind(userId)
      .all<UserIdentityRow>();
    return (result.results ?? []).map(toUserIdentity);
  }

  async createUser(user: NewUser): Promise<User> {
    const id = generateId();
    const now = Date.now();
    const email = normalizeEmail(user.email);
    const emailVerified = email !== null && user.emailVerified === true;

    await this.db
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        id,
        user.displayName ?? null,
        email,
        emailVerified ? 1 : 0,
        user.avatarUrl ?? null,
        now,
        now
      )
      .run();

    return {
      id,
      displayName: user.displayName ?? null,
      email,
      emailVerified,
      avatarUrl: user.avatarUrl ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async createIdentity(identity: NewUserIdentity): Promise<UserIdentity> {
    const id = generateId();
    const now = Date.now();
    const email = normalizeEmail(identity.providerEmail);
    const issuer = getSignInProviderIssuer(identity.provider);

    await this.db
      .prepare(
        "INSERT INTO user_identities (id, user_id, provider, provider_user_id, provider_login, provider_email, provider_issuer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        id,
        identity.userId,
        identity.provider,
        identity.providerUserId,
        identity.providerLogin ?? null,
        email,
        issuer,
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
      providerIssuer: issuer,
      createdAt: now,
    };
  }

  /**
   * Set a display name or avatar the user lacks (NULL or blank) and never
   * overwrite one it has. Each field is a single guarded UPDATE, so a value
   * another writer stores first always wins. Blank inputs are ignored.
   */
  async fillMissingProfile(
    userId: string,
    profile: { displayName?: string; avatarUrl?: string }
  ): Promise<void> {
    const now = Date.now();
    const fill = (column: "display_name" | "avatar_url", value: string | undefined) => {
      const trimmed = value?.trim();
      return trimmed
        ? this.db
            .prepare(
              `UPDATE users SET ${column} = ?, updated_at = ?
               WHERE id = ? AND (${column} IS NULL OR TRIM(${column}) = '')`
            )
            .bind(trimmed, now, userId)
        : null;
    };
    const statements = [
      fill("display_name", profile.displayName),
      fill("avatar_url", profile.avatarUrl),
    ].filter((statement) => statement !== null);
    if (statements.length > 0) await this.db.batch(statements);
  }

  // ── Private ─────────────────────────────────────────────────────

  private async doResolveOrCreate(
    identity: ProviderIdentity,
    requireEnrollmentAdmission: EnrollmentAdmission
  ): Promise<ResolvedUser> {
    const normalizedEmail = normalizeEmail(identity.providerEmail);

    // Step 1: Look up by provider identity
    const existing = await this.getIdentity(identity.provider, identity.providerUserId);

    if (existing) {
      // Step 2: Existing identity → return linked user; profile claims for
      // known actors are applied by KnownActorProfileClaim.
      const user = await this.getUserById(existing.userId);
      if (!user) {
        throw new Error(`Orphaned identity ${existing.id}: user ${existing.userId} not found`);
      }

      return {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        outcome: "existing",
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
          outcome: "linked",
        };
      }
    }

    // Step 4: Brand new user — batch user + identity creation so a UNIQUE
    // failure on the identity INSERT rolls back the user INSERT, preventing
    // orphaned user rows under concurrent requests.
    await requireEnrollmentAdmission({ ...identity, providerEmail: normalizedEmail ?? undefined });
    const userId = generateId();
    const identityId = generateId();
    const now = Date.now();
    const displayName = identity.displayName ?? null;
    const avatarUrl = identity.avatarUrl ?? null;
    const issuer = getSignInProviderIssuer(identity.provider);

    const emailVerified =
      normalizedEmail !== null && EMAIL_ATTESTING_PROVIDERS.has(identity.provider);

    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO users (id, display_name, email, email_verified, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(userId, displayName, normalizedEmail, emailVerified ? 1 : 0, avatarUrl, now, now),
      this.db
        .prepare(
          "INSERT INTO user_identities (id, user_id, provider, provider_user_id, provider_login, provider_email, provider_issuer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          identityId,
          userId,
          identity.provider,
          identity.providerUserId,
          identity.providerLogin ?? null,
          normalizedEmail,
          issuer,
          now
        ),
    ]);

    return {
      id: userId,
      displayName,
      email: normalizedEmail,
      outcome: "created",
    };
  }
}
