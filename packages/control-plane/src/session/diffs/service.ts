import {
  SESSION_DIFF_ID_PATTERN,
  sessionDiffFailureSchema,
  sessionDiffUploadSchema,
  type SandboxEvent,
  type SessionDiffBaselineRepository,
  type SessionDiffState,
  type SessionDiffUpload,
} from "@open-inspect/shared";
import { generateId } from "../../auth/crypto";
import type { Logger } from "../../logger";
import type { SessionMessenger } from "../messenger";
import type { SessionRepository } from "../repository";
import { repoIdentityEquals, type SessionRepositoryEntry } from "../repository-target";
import {
  DiffBaselineMismatchError,
  DiffBaselineUnavailableError,
  DiffRepositoryMismatchError,
  InvalidDiffBundleError,
  InvalidDiffFailureError,
  InvalidDiffFileIdentityError,
  SandboxNotConnectedError,
} from "./errors";
import type { SessionDiffStore } from "./store";

/** SHAs are hex, so a plain case-insensitive comparison suffices. */
function shaEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Owns validation and the single latest-bundle publication boundary.
 * Domain layer: methods throw the errors in ./errors; the HTTP handler
 * maps them to responses.
 */
export class SessionDiffService {
  constructor(
    private readonly store: SessionDiffStore,
    private readonly repository: SessionRepository,
    private readonly messenger: SessionMessenger,
    private readonly log: Logger,
    private readonly generateRevisionId: () => string = () => generateId(),
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Return the latest patch-free manifest and any non-destructive refresh error. */
  getPublicState(): SessionDiffState {
    const repositories = this.repository.getSessionRepositories();
    const missingBaseline = repositories.some((repository) => !repository.row?.base_sha);
    return this.store.getPublicState(
      missingBaseline ? "Changes unavailable for this session" : null
    );
  }

  /**
   * Pin immutable baselines advertised by the sandbox's ready event.
   * Repository order and identity must match the session's configured repositories.
   */
  pinBaselines(event: Extract<SandboxEvent, { type: "ready" }>): void {
    const sessionRepositories = this.repository.getSessionRepositories();
    const advertised = event.repositories ?? [];
    if (!this.advertisedMatchesSession(advertised, sessionRepositories)) {
      this.log.warn("session_diff.baseline_repository_mismatch", {
        advertised_repositories: advertised.length,
        session_repositories: sessionRepositories.length,
      });
      return;
    }

    this.logBaselineConflicts(advertised, sessionRepositories);
    this.repository.setSessionDiffBaselines(
      this.toBaselineUpdates(advertised, sessionRepositories)
    );
  }

  private advertisedMatchesSession(
    advertised: SessionDiffBaselineRepository[],
    sessionRepositories: SessionRepositoryEntry[]
  ): boolean {
    return (
      advertised.length === sessionRepositories.length &&
      sessionRepositories.every((sessionRepository, index) => {
        const baseline = advertised[index];
        return (
          baseline?.position === sessionRepository.position &&
          repoIdentityEquals(baseline, sessionRepository)
        );
      })
    );
  }

  private logBaselineConflicts(
    advertised: SessionDiffBaselineRepository[],
    sessionRepositories: SessionRepositoryEntry[]
  ): void {
    for (const [index, sessionRepository] of sessionRepositories.entries()) {
      const existing = sessionRepository.row?.base_sha;
      const next = advertised[index]!.baseSha;
      if (existing && !shaEquals(existing, next)) {
        this.log.warn("session_diff.baseline_conflict", {
          repository_position: sessionRepository.position,
          repo_owner: sessionRepository.repoOwner,
          repo_name: sessionRepository.repoName,
        });
      }
    }
  }

  private toBaselineUpdates(
    advertised: SessionDiffBaselineRepository[],
    sessionRepositories: SessionRepositoryEntry[]
  ) {
    return sessionRepositories.map((sessionRepository, index) => ({
      position: sessionRepository.position,
      repoOwner: sessionRepository.repoOwner,
      repoName: sessionRepository.repoName,
      baseSha: advertised[index]!.baseSha,
      isPrimary: sessionRepository.isPrimary,
    }));
  }

  /**
   * Validate and atomically publish a sandbox-produced bundle as the latest
   * revision, returning its revision id.
   */
  publishBundle(input: unknown): string {
    const parsed = sessionDiffUploadSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidDiffBundleError();
    }
    this.assertRepositorySetMatches(parsed.data);

    const revisionId = this.generateRevisionId();
    const now = this.now();
    this.store.replaceBundle(parsed.data, revisionId, now);
    this.broadcastState(now);
    return revisionId;
  }

  /** Record a bounded refresh error without discarding the previous successful bundle. */
  recordRefreshFailure(input: unknown): void {
    const parsed = sessionDiffFailureSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidDiffFailureError();
    }
    const now = this.now();
    this.store.recordFailure(parsed.data.error, now);
    this.broadcastState(now);
  }

  /** Resolve a patch only when both its revision and file identity are current. */
  resolveFile(revisionId: string | null, fileId: string | null): string {
    if (!this.isValidId(revisionId) || !this.isValidId(fileId)) {
      throw new InvalidDiffFileIdentityError();
    }
    return this.store.resolveFile(revisionId, fileId);
  }

  /** Request a non-blocking refresh from the connected session sandbox. */
  requestRefresh(): void {
    if (!this.messenger.sendToSandbox({ type: "refresh_diff" })) {
      throw new SandboxNotConnectedError();
    }
  }

  private assertRepositorySetMatches(bundle: SessionDiffUpload): void {
    const sessionRepositories = this.repository.getSessionRepositories();
    if (bundle.repositories.length !== sessionRepositories.length) {
      throw new DiffRepositoryMismatchError();
    }
    for (const sessionRepository of sessionRepositories) {
      const repository = bundle.repositories.find(
        (candidate) => candidate.position === sessionRepository.position
      );
      if (!repository || !repoIdentityEquals(repository, sessionRepository)) {
        throw new DiffRepositoryMismatchError();
      }
      const baseSha = sessionRepository.row?.base_sha;
      if (!baseSha) {
        throw new DiffBaselineUnavailableError();
      }
      if (!shaEquals(repository.baseSha, baseSha)) {
        throw new DiffBaselineMismatchError();
      }
    }
  }

  private broadcastState(updatedAt: number): void {
    this.messenger.broadcast({
      type: "diff_state_changed",
      revisionId: this.getPublicState().current?.revisionId ?? null,
      updatedAt,
    });
  }

  private isValidId(value: string | null): value is string {
    return typeof value === "string" && SESSION_DIFF_ID_PATTERN.test(value);
  }
}
