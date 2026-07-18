import {
  sessionDiffFailureSchema,
  sessionDiffUploadSchema,
  type SandboxEvent,
  type ServerMessage,
  type SessionDiffState,
  type SessionDiffUpload,
} from "@open-inspect/shared";
import type { Logger } from "../../logger";
import type { SessionRepository } from "../repository";
import type { SessionDiffStore } from "./store";

interface TransactionStorage {
  transactionSync<T>(closure: () => T): T;
}

interface SessionDiffServiceDeps {
  store: SessionDiffStore;
  repository: Pick<SessionRepository, "getSessionRepositories" | "setSessionDiffBaselines">;
  storage: TransactionStorage;
  log: Pick<Logger, "warn">;
  generateId: () => string;
  now: () => number;
  hasSandboxConnection: () => boolean;
  sendRefreshCommand: (command: { type: "refresh_diff" }) => boolean;
  broadcast: (message: Extract<ServerMessage, { type: "diff_state_changed" }>) => void;
}

const DIFF_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/** Owns validation and the single latest-bundle publication boundary. */
export class SessionDiffService {
  constructor(private readonly deps: SessionDiffServiceDeps) {}

  getPublicState(): SessionDiffState {
    const repositories = this.deps.repository.getSessionRepositories();
    const missingBaseline = repositories.some((repository) => !repository.row?.base_sha);
    return this.deps.store.getPublicState(
      missingBaseline ? "Changes unavailable for this session" : null
    );
  }

  handleState(): Response {
    return Response.json(this.getPublicState());
  }

  async handleReady(event: Extract<SandboxEvent, { type: "ready" }>): Promise<void> {
    const members = this.deps.repository.getSessionRepositories();
    const advertised = event.repositories ?? [];
    const membershipMatches =
      advertised.length === members.length &&
      members.every((member, index) => {
        const baseline = advertised[index];
        return (
          baseline?.position === member.position &&
          baseline.repoOwner.toLocaleLowerCase("en-US") ===
            member.repoOwner.toLocaleLowerCase("en-US") &&
          baseline.repoName.toLocaleLowerCase("en-US") ===
            member.repoName.toLocaleLowerCase("en-US")
        );
      });
    if (!membershipMatches) {
      this.deps.log.warn("session_diff.baseline_membership_mismatch", {
        advertised_repositories: advertised.length,
        session_repositories: members.length,
      });
      return;
    }

    for (const [index, member] of members.entries()) {
      const existing = member.row?.base_sha;
      const next = advertised[index]!.baseSha;
      if (existing && existing.toLocaleLowerCase("en-US") !== next.toLocaleLowerCase("en-US")) {
        this.deps.log.warn("session_diff.baseline_conflict", {
          repository_position: member.position,
          repo_owner: member.repoOwner,
          repo_name: member.repoName,
        });
      }
    }

    this.deps.storage.transactionSync(() => {
      this.deps.repository.setSessionDiffBaselines(
        members.map((member, index) => ({
          position: member.position,
          repoOwner: member.repoOwner,
          repoName: member.repoName,
          baseSha: advertised[index]!.baseSha,
          isPrimary: member.isPrimary,
        }))
      );
    });
  }

  async handleUpload(request: Request): Promise<Response> {
    const parsed = sessionDiffUploadSchema.safeParse(await this.readJson(request));
    if (!parsed.success) {
      return Response.json({ error: "Invalid session diff bundle" }, { status: 400 });
    }
    const membershipError = this.validateMembership(parsed.data);
    if (membershipError) {
      return Response.json({ error: membershipError.message }, { status: membershipError.status });
    }

    const revisionId = this.deps.generateId();
    const now = this.deps.now();
    this.deps.storage.transactionSync(() => {
      this.deps.store.replaceBundle(parsed.data, revisionId, now);
    });
    this.broadcastState(now);
    return Response.json({ revisionId });
  }

  async handleFailure(request: Request): Promise<Response> {
    const parsed = sessionDiffFailureSchema.safeParse(await this.readJson(request));
    if (!parsed.success) {
      return Response.json({ error: "Invalid session diff failure" }, { status: 400 });
    }
    const now = this.deps.now();
    this.deps.storage.transactionSync(() => {
      this.deps.store.recordFailure(parsed.data.error, now);
    });
    this.broadcastState(now);
    return new Response(null, { status: 204 });
  }

  handleResolveFile(url: URL): Response {
    const revisionId = this.readId(url.searchParams.get("revisionId"));
    const fileId = this.readId(url.searchParams.get("fileId"));
    if (!revisionId || !fileId) {
      return Response.json({ error: "Invalid diff file identity" }, { status: 400 });
    }
    const result = this.deps.store.resolveFile(revisionId, fileId);
    if (!result.ok) {
      return Response.json(
        {
          error: result.status === 409 ? "Diff revision is stale" : "Diff file not found",
          code: result.status === 409 ? "diff_revision_stale" : "diff_file_not_found",
          currentRevisionId: result.currentRevisionId,
        },
        { status: result.status }
      );
    }
    return new Response(result.patch, {
      headers: {
        "Content-Type": "text/x-diff; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
  }

  handleRetry(): Response {
    if (!this.deps.hasSandboxConnection()) {
      return Response.json({ error: "Sandbox is not connected" }, { status: 409 });
    }
    if (!this.deps.sendRefreshCommand({ type: "refresh_diff" })) {
      return Response.json({ error: "Sandbox is not connected" }, { status: 409 });
    }
    return Response.json({ accepted: true }, { status: 202 });
  }

  private validateMembership(
    bundle: SessionDiffUpload
  ): { status: 400 | 409; message: string } | null {
    const members = this.deps.repository.getSessionRepositories();
    if (bundle.repositories.length !== members.length) {
      return { status: 400, message: "Repository membership does not match session" };
    }
    for (const member of members) {
      const repository = bundle.repositories.find(
        (candidate) => candidate.position === member.position
      );
      if (
        !repository ||
        repository.repoOwner.toLocaleLowerCase("en-US") !==
          member.repoOwner.toLocaleLowerCase("en-US") ||
        repository.repoName.toLocaleLowerCase("en-US") !==
          member.repoName.toLocaleLowerCase("en-US")
      ) {
        return { status: 400, message: "Repository membership does not match session" };
      }
      const baseSha = member.row?.base_sha;
      if (!baseSha) {
        return { status: 409, message: "Session start baseline is unavailable" };
      }
      if (repository.baseSha.toLocaleLowerCase("en-US") !== baseSha.toLocaleLowerCase("en-US")) {
        return { status: 400, message: "Repository baseline does not match session" };
      }
    }
    return null;
  }

  private broadcastState(updatedAt: number): void {
    this.deps.broadcast({
      type: "diff_state_changed",
      revisionId: this.getPublicState().current?.revisionId ?? null,
      updatedAt,
    });
  }

  private async readJson(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  private readId(value: unknown): string | null {
    return typeof value === "string" && DIFF_ID_PATTERN.test(value) ? value : null;
  }
}
