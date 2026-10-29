import {
  BUILT_IN_ROLE_REGISTRY,
  MEMBER_MERGE_BLOCKER_MESSAGES,
  type MemberIdentity,
  type MemberMergeBlocker,
  type MemberMergePreview,
  type MemberMergeResult,
  type WorkspaceMember,
} from "@open-inspect/shared/rbac";
import type { SqlDatabase } from "../db/sql-database";
import {
  emptyUserMergeCounts,
  hasCompletedUserMerge,
  mergeUsers,
  UserMergeError,
  type UserMergeCounts,
  type UserMergeGuard,
} from "../db/user-merge";
import type { UserStore } from "../db/user-store";
import { rolePermissionPredicate } from "./permission-sql";
import { AuthorizationError, RbacConflictError, type AuthorizationService } from "./service";

/** A merge that cannot proceed until an administrator changes member state. */
export class MemberMergeBlockedError extends Error {
  readonly blocker: MemberMergeBlocker;

  /** Creates a refusal carrying its stable blocker code and a readable message. */
  constructor(blocker: MemberMergeBlocker) {
    super(MEMBER_MERGE_BLOCKER_MESSAGES[blocker]);
    this.name = "MemberMergeBlockedError";
    this.blocker = blocker;
  }
}

/** Identifies a merge: the source member's records fold into the kept target member. */
export interface MemberMergeRequest {
  sourceUserId: string;
  targetUserId: string;
  actorUserId: string;
}

/**
 * Previews and applies administrator-initiated member merges on top of the `mergeUsers`
 * primitive, adding actor-level policy: nobody merges away their own account, Owner accounts
 * require ownership-transfer rights, and the actor's grants are re-checked inside the write.
 */
export class MemberMergeService {
  /** Creates a service over the workspace database and its authorization and user stores. */
  constructor(
    private readonly db: SqlDatabase,
    private readonly authorization: AuthorizationService,
    private readonly users: UserStore
  ) {}

  /** Describes both members, the first blocker if any, and the records a merge would move. */
  async preview(input: MemberMergeRequest): Promise<MemberMergePreview> {
    const { source, target } = await this.loadMembers(input);
    // Decided apart from which blocker is shown: Owner-account identities are readable only by an
    // actor who could merge Owner accounts, whatever else blocks this merge.
    const mayMergeOwners = await this.actorMayMergeOwners(input.actorUserId, source, target);
    const [sourceIdentities, targetIdentities] = mayMergeOwners
      ? await Promise.all([this.loadIdentities(source.userId), this.loadIdentities(target.userId)])
      : [null, null];
    let blocker = actorBlocker(input, mayMergeOwners);
    let counts: UserMergeCounts | null = null;
    if (!blocker) {
      try {
        counts = (
          await mergeUsers(this.db, {
            survivorId: target.userId,
            loserId: source.userId,
            dryRun: true,
          })
        ).counts;
      } catch (cause) {
        const refusal = toServiceError(cause);
        if (!(refusal instanceof MemberMergeBlockedError)) throw refusal;
        blocker = refusal.blocker;
      }
    }
    return {
      source: { member: source, identities: sourceIdentities },
      target: { member: target, identities: targetIdentities },
      blocker,
      counts,
    };
  }

  /** Atomically folds the source member into the target, audited as the acting user. */
  async merge(input: MemberMergeRequest & { requestId: string }): Promise<MemberMergeResult> {
    const [source, target] = await Promise.all([
      this.authorization.getMember(input.sourceUserId),
      this.authorization.getMember(input.targetUserId),
    ]);
    if (!target) throw new AuthorizationError(404, "member_not_found");
    if (!source) {
      // Replaying a merge of this exact pair, e.g. after its response was lost, is a no-op. A
      // source merged into some other member is still not found.
      if (await hasCompletedUserMerge(this.db, target.userId, input.sourceUserId)) {
        return {
          sourceUserId: input.sourceUserId,
          targetUserId: target.userId,
          counts: emptyUserMergeCounts(),
        };
      }
      throw new AuthorizationError(404, "member_not_found");
    }
    const blocker = actorBlocker(
      input,
      await this.actorMayMergeOwners(input.actorUserId, source, target)
    );
    if (blocker === "owner_transfer_required") {
      throw new AuthorizationError(403, "permission_required", "workspace.transfer_ownership");
    }
    if (blocker) throw new MemberMergeBlockedError(blocker);
    try {
      const result = await mergeUsers(this.db, {
        survivorId: target.userId,
        loserId: source.userId,
        actor: {
          kind: "user",
          userId: input.actorUserId,
          requestId: input.requestId,
          guard: actorGuard(input),
        },
      });
      return { sourceUserId: source.userId, targetUserId: target.userId, counts: result.counts };
    } catch (cause) {
      throw toServiceError(cause);
    }
  }

  private async loadMembers(
    input: MemberMergeRequest
  ): Promise<{ source: WorkspaceMember; target: WorkspaceMember }> {
    const [source, target] = await Promise.all([
      this.authorization.getMember(input.sourceUserId),
      this.authorization.getMember(input.targetUserId),
    ]);
    if (!source || !target) throw new AuthorizationError(404, "member_not_found");
    return { source, target };
  }

  private async loadIdentities(userId: string): Promise<MemberIdentity[]> {
    const identities = await this.users.getIdentitiesForUser(userId);
    return identities.map((identity) => ({
      provider: identity.provider,
      login: identity.providerLogin,
      email: identity.providerEmail,
    }));
  }

  /** Owner accounts may be merged, and their identities read, only with ownership transfer. */
  private async actorMayMergeOwners(
    actorUserId: string,
    source: WorkspaceMember,
    target: WorkspaceMember
  ): Promise<boolean> {
    if (source.role.key !== "owner" && target.role.key !== "owner") return true;
    const actor = await this.authorization.getEffectiveAuthorization(actorUserId);
    return actor.permissions.includes("workspace.transfer_ownership");
  }
}

function actorBlocker(
  input: MemberMergeRequest,
  mayMergeOwners: boolean
): MemberMergeBlocker | null {
  if (input.sourceUserId === input.actorUserId) return "source_is_actor";
  return mayMergeOwners ? null : "owner_transfer_required";
}

/** The acting user must still hold the merge grant, plus ownership transfer for Owner accounts. */
function actorGuard(input: MemberMergeRequest): UserMergeGuard {
  const merge = rolePermissionPredicate("workspace.members.merge");
  const transfer = rolePermissionPredicate("workspace.transfer_ownership");
  return {
    sql: `? <> ? AND EXISTS (
      SELECT 1 FROM users u
      JOIN user_role_assignments ura ON ura.user_id = u.id
      JOIN roles r ON r.id = ura.role_id
      WHERE u.id = ? AND u.suspended_at IS NULL AND ${merge.sql}
        AND (${transfer.sql} OR NOT EXISTS (
          SELECT 1 FROM user_role_assignments party_assignment
          WHERE party_assignment.user_id IN (?, ?) AND party_assignment.role_id = ?
        ))
    )`,
    values: [
      input.actorUserId,
      input.sourceUserId,
      input.actorUserId,
      ...merge.values,
      ...transfer.values,
      input.sourceUserId,
      input.targetUserId,
      BUILT_IN_ROLE_REGISTRY.owner.id,
    ],
  };
}

/** Translates a merge refusal, from preflight or the in-batch decision, into an API error. */
function toServiceError(cause: unknown): unknown {
  if (!(cause instanceof UserMergeError)) return cause;
  switch (cause.code) {
    case "role_assignment_missing":
    case "role_conflict":
    case "suspension_conflict":
    case "owner_suspended":
    case "identity_conflict":
      return new MemberMergeBlockedError(cause.code);
    case "actor_authorization_changed":
      return new RbacConflictError("Actor authorization changed");
    case "preconditions_changed":
    case "source_changed":
      return new RbacConflictError("Member merge preconditions changed");
    case "self_merge":
    case "survivor_not_found":
      return new AuthorizationError(404, "member_not_found");
  }
}
