import {
  sessionSnapshotSchema,
  type SessionSnapshotState,
} from "@open-inspect/shared/types/server-messages";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import type { SessionRepositoryState } from "@open-inspect/shared/types/repositories";
import type { Logger } from "../logger";
import type { SqlDatabase } from "../db/sql-database";
import { EnvironmentStore } from "../db/environments";
import { DEFAULT_SANDBOX_STATUS } from "../sandbox/sandbox-status";
import type { SandboxDashboardSettings } from "./sandbox-access";
import { resolveSandboxDashboardUrl } from "./sandbox-access";
import { findPrArtifactForRepo } from "./pr-artifacts";
import { resolvePublicSessionId } from "./public-session-id";
import { safeParseTunnelUrls } from "./tunnel-urls";
import type { ArtifactRepository } from "./artifact-repository";
import type { MessageRepository } from "./message-repository";
import type { SandboxRepository } from "./sandbox-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionEventStream } from "./event-stream";
import type { MessageService } from "./services/message.service";
import type { SessionRow, SandboxRow } from "./types";
import { DEFAULT_BASE_BRANCH } from "../repos/default-branch";

export interface SessionSnapshotEnrichment {
  environmentId: string | null;
  environmentName: string | null;
}

export interface SessionSnapshotReaderDeps {
  sessionCoreRepository: SessionCoreRepository;
  sandboxRepository: SandboxRepository;
  messageRepository: MessageRepository;
  artifactRepository: ArtifactRepository;
  messageService: MessageService;
  eventStream: SessionEventStream;
  sandboxDashboardSettings: SandboxDashboardSettings;
  /** Null when the deployment has no D1 binding — environment names resolve null. */
  db: SqlDatabase | null;
  durableObjectId: string;
  /** DO storage transaction so the snapshot reads are a consistent cut. */
  transaction: <T>(closure: () => T) => T;
  log: Logger;
}

/**
 * Read model for the session: the snapshot served over HTTP and pushed on
 * subscribe, and the per-repository git state it embeds.
 */
export class SessionSnapshotReader {
  constructor(private readonly deps: SessionSnapshotReaderDeps) {}

  async handleSnapshot(): Promise<Response> {
    const headers = { "Cache-Control": "private, no-store" };
    const enrichment = await this.resolveSessionSnapshotEnrichment();
    const snapshot = this.readSessionSnapshot(enrichment);
    if (!snapshot) {
      return Response.json({ error: "Session not found" }, { status: 404, headers });
    }
    return Response.json(sessionSnapshotSchema.parse(snapshot), { headers });
  }

  async resolveSessionSnapshotEnrichment(): Promise<SessionSnapshotEnrichment> {
    const session = this.deps.sessionCoreRepository.getSession();
    const environmentId = session?.environment_id ?? null;
    const environmentName = await this.resolveEnvironmentName(environmentId);
    return { environmentId, environmentName };
  }

  readSessionSnapshot(enrichment: SessionSnapshotEnrichment) {
    return this.deps.transaction(() => {
      const local = this.readSessionState(enrichment);
      if (!local) return null;
      return {
        session: local.session,
        artifacts: this.deps.messageService.listArtifacts().artifacts,
        timeline: this.deps.eventStream.getReplay(),
        promptQueue: this.deps.messageRepository.listPromptQueue(),
        spawnError: local.sandbox?.last_spawn_error ?? null,
      };
    });
  }

  private readSessionState(
    enrichment: SessionSnapshotEnrichment
  ): { session: SessionSnapshotState; sandbox: SandboxRow | null } | null {
    const session = this.deps.sessionCoreRepository.getSession();
    if (!session) return null;
    const sandbox = this.deps.sandboxRepository.getSandbox();
    const publicSession: SessionSnapshotState = {
      id: resolvePublicSessionId(session, this.deps.durableObjectId),
      title: session.title,
      repoOwner: session.repo_owner,
      repoName: session.repo_name,
      baseBranch: session.base_branch,
      branchName: session.branch_name,
      status: session.status,
      sandboxStatus: sandbox?.status ?? DEFAULT_SANDBOX_STATUS,
      messageCount: this.deps.messageRepository.getMessageCount(),
      createdAt: session.created_at,
      model: session.model ?? DEFAULT_MODEL,
      reasoningEffort: session.reasoning_effort ?? undefined,
      isProcessing: this.getIsProcessing(),
      parentSessionId: session.parent_session_id,
      totalCost: session.total_cost ?? 0,
      codeServerUrl: sandbox?.code_server_url ?? null,
      vncUrl: sandbox?.vnc_url ?? null,
      tunnelUrls: sandbox?.tunnel_urls
        ? safeParseTunnelUrls(sandbox.tunnel_urls, this.deps.log)
        : null,
      ttydUrl: sandbox?.ttyd_url ?? null,
      sandboxDashboardUrl: resolveSandboxDashboardUrl(
        this.deps.sandboxDashboardSettings,
        sandbox?.modal_object_id
      ),
      repositories: this.getSessionRepositoryStates(session),
      environmentId: session.environment_id ?? null,
      environmentName:
        session.environment_id === enrichment.environmentId ? enrichment.environmentName : null,
    };
    return { session: publicSession, sandbox };
  }

  /**
   * The launch environment's current display name, or null when the session has
   * no environment or the environment was deleted after launch (§7.6). Resolved
   * live rather than snapshotted so deletion is reflected; best-effort, so a
   * lookup failure resolves null rather than failing the whole state read.
   */
  private async resolveEnvironmentName(environmentId: string | null): Promise<string | null> {
    if (!environmentId || !this.deps.db) {
      return null;
    }
    try {
      const environment = await new EnvironmentStore(this.deps.db).getById(environmentId);
      return environment?.name ?? null;
    } catch (e) {
      this.deps.log.warn("Failed to resolve environment name for session state", {
        environment_id: environmentId,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Member repositories for SessionState, in position order (see
   * buildSessionRepositories for the scalar-mirror fallback). Members synthesized
   * from the scalars — and member rows written before per-repo git state
   * existed, whose git columns are null while the scalars are set — have the
   * primary entry overlaid with the session scalars.
   */
  private getSessionRepositoryStates(session: SessionRow | null): SessionRepositoryState[] {
    const prUrlForRepo = this.getPrUrlLookup();
    return this.deps.sessionCoreRepository.getSessionRepositories().map((member) => ({
      position: member.position,
      repoOwner: member.repoOwner,
      repoName: member.repoName,
      repoId: member.row ? member.row.repo_id : (session?.repo_id ?? null),
      baseBranch: member.baseBranch ?? DEFAULT_BASE_BRANCH,
      branchName:
        member.row?.branch_name ?? (member.isPrimary ? (session?.branch_name ?? null) : null),
      baseSha: member.row?.base_sha ?? (member.isPrimary ? (session?.base_sha ?? null) : null),
      currentSha:
        member.row?.current_sha ?? (member.isPrimary ? (session?.current_sha ?? null) : null),
      prUrl: prUrlForRepo(member.repoOwner, member.repoName, member.isPrimary),
    }));
  }

  /** Per-repo PR URL lookup over the session's PR artifacts. */
  private getPrUrlLookup(): (
    repoOwner: string,
    repoName: string,
    isPrimary: boolean
  ) => string | null {
    const artifacts = this.deps.artifactRepository
      .listArtifacts()
      .filter((artifact) => artifact.url !== null);
    return (repoOwner, repoName, isPrimary) =>
      findPrArtifactForRepo(artifacts, { repoOwner, repoName }, isPrimary)?.url ?? null;
  }

  private getIsProcessing(): boolean {
    return this.deps.messageRepository.getProcessingMessage() !== null;
  }
}
