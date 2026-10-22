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
import { mergeUsers, UserMergeError, type UserMergeGuard } from "../db/user-merge";
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
    let blocker = await this.actorBlocker(input, source, target);
    // Linked identities are Owner-account details an actor without ownership rights may not read.
    const withholdIdentities = blocker === "owner_transfer_required";
    const [sourceIdentities, targetIdentities] = withholdIdentities
      ? [null, null]
      : await Promise.all([this.loadIdentities(source.userId), this.loadIdentities(target.userId)]);
    let counts: Record<string, number> | null = null;
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
        blocker = toBlocker(cause);
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
    const { source, target } = await this.loadMembers(input);
    const blocker = await this.actorBlocker(input, source, target);
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
      throw await this.explainFailedMerge(input, cause);
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

  private async actorBlocker(
    input: MemberMergeRequest,
    source: WorkspaceMember,
    target: WorkspaceMember
  ): Promise<MemberMergeBlocker | null> {
    if (input.sourceUserId === input.actorUserId) return "source_is_actor";
    if (source.role.key !== "owner" && target.role.key !== "owner") return null;
    const actor = await this.authorization.getEffectiveAuthorization(input.actorUserId);
    return actor.permissions.includes("workspace.transfer_ownership")
      ? null
      : "owner_transfer_required";
  }

  /**
   * The in-batch guard aborts the write with a constraint error when state changed after
   * preflight. Re-reading state distinguishes that conflict from a database outage.
   */
  private async explainFailedMerge(input: MemberMergeRequest, cause: unknown): Promise<unknown> {
    if (cause instanceof UserMergeError) return blockedError(cause);
    try {
      const actor = await this.authorization.getEffectiveAuthorization(input.actorUserId);
      if (!actor.permissions.includes("workspace.members.merge")) {
        return new RbacConflictError("Actor authorization changed");
      }
      const preview = await this.preview(input);
      if (preview.blocker) return new MemberMergeBlockedError(preview.blocker);
    } catch (recheck) {
      if (recheck instanceof AuthorizationError) {
        return new RbacConflictError("Member merge preconditions changed");
      }
    }
    return cause;
  }
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

function toBlocker(cause: unknown): MemberMergeBlocker {
  const blocked = blockedError(cause);
  if (blocked instanceof MemberMergeBlockedError) return blocked.blocker;
  throw blocked;
}

function blockedError(cause: unknown): unknown {
  if (!(cause instanceof UserMergeError)) return cause;
  switch (cause.code) {
    case "role_assignment_missing":
    case "role_conflict":
    case "suspension_conflict":
    case "owner_suspended":
      return new MemberMergeBlockedError(cause.code);
    case "source_changed":
      return new RbacConflictError("Member merge preconditions changed");
    case "self_merge":
    case "survivor_not_found":
      return new AuthorizationError(404, "member_not_found");
  }
}
