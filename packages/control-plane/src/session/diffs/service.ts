import {
  SESSION_DIFF_CAPTURE_TIMEOUT_MS,
  SESSION_DIFF_MAX_CAPTURE_BYTES,
  SESSION_DIFF_MAX_FILES,
  SESSION_DIFF_MAX_PATCH_BYTES,
  diffCaptureCompleteRequestSchema,
  diffCaptureFailureRequestSchema,
  type SandboxEvent,
  type ServerMessage,
  type SessionDiffState,
} from "@open-inspect/shared";
import type { Logger } from "../../logger";
import type { CaptureDiffCommand } from "../types";
import type { SessionRepository } from "../repository";
import type { SessionAlarmCoordinator } from "../alarm/coordinator";
import type { SessionDiffStore } from "./store";

interface TransactionStorage {
  transactionSync<T>(closure: () => T): T;
}

interface SessionDiffServiceDeps {
  store: SessionDiffStore;
  repository: SessionRepository;
  alarms: SessionAlarmCoordinator;
  storage: TransactionStorage;
  log: Pick<Logger, "warn">;
  generateId: () => string;
  now: () => number;
  getPublicSessionId: () => string;
  hasSandboxConnection: () => boolean;
  sendCaptureCommand: (command: CaptureDiffCommand) => boolean;
  deleteObject: (objectKey: string) => Promise<void>;
  broadcast: (message: Extract<ServerMessage, { type: "diff_state_changed" }>) => void;
  processMessageQueue: () => Promise<void>;
}

/** Owns the session-diff state machine and its transport/storage orchestration. */
export class SessionDiffService {
  constructor(private readonly deps: SessionDiffServiceDeps) {}

  initializeNewSession(now: number): void {
    this.deps.store.initializeNewSession(now);
  }

  getPublicState(): SessionDiffState {
    return this.deps.store.getPublicState();
  }

  getDispatchBlockReason(): string | null {
    return this.deps.store.getDispatchBlockReason();
  }

  async handleReady(event: Extract<SandboxEvent, { type: "ready" }>): Promise<void> {
    if (this.deps.store.getBaselineStatus() !== "pending") return;

    const members = this.deps.repository.getSessionRepositories();
    const advertised = event.repositories ?? [];
    const capable = event.capabilities?.includes("session_diff_v1") ?? false;
    const validMembership =
      capable &&
      advertised.length === members.length &&
      members.every((member, position) => {
        const baseline = advertised[position];
        return (
          baseline?.position === member.position &&
          baseline.repoOwner.toLowerCase() === member.repoOwner.toLowerCase() &&
          baseline.repoName.toLowerCase() === member.repoName.toLowerCase()
        );
      });
    const now = this.deps.now();

    this.deps.storage.transactionSync(() => {
      if (validMembership) {
        this.deps.repository.setSessionDiffBaselines(
          members.map((member, position) => ({
            repoOwner: member.repoOwner,
            repoName: member.repoName,
            baseSha: advertised[position]!.baseSha,
            isPrimary: member.isPrimary,
          }))
        );
        this.deps.store.setBaselineReady(now);
      } else {
        this.deps.store.setBaselineUnavailable(
          capable
            ? "Runtime repository baselines did not match this session"
            : "This runtime does not support session changes",
          now
        );
      }
    });

    this.broadcastState(now);
    await this.deps.processMessageQueue();
  }

  async beginCapture(triggerMessageId: string): Promise<void> {
    const members = this.deps.repository.getSessionRepositories();
    if (members.length === 0 || this.deps.store.getBaselineStatus() !== "ready") return;

    const baselines = members.flatMap((member) => {
      const baseSha = member.row?.base_sha ?? null;
      return baseSha
        ? [
            {
              position: member.position,
              repoOwner: member.repoOwner,
              repoName: member.repoName,
              baseSha,
            },
          ]
        : [];
    });
    if (baselines.length !== members.length) return;

    const captureId = this.deps.generateId();
    const now = this.deps.now();
    const started = this.deps.storage.transactionSync(() =>
      this.deps.store.beginCapture(triggerMessageId, captureId, now)
    );
    if (!started) return;

    this.broadcastState(now, "capturing");
    const sent = this.deps.sendCaptureCommand({
      type: "capture_diff",
      captureId,
      baselines,
      limits: {
        maxFiles: SESSION_DIFF_MAX_FILES,
        maxPatchBytes: SESSION_DIFF_MAX_PATCH_BYTES,
        maxCaptureBytes: SESSION_DIFF_MAX_CAPTURE_BYTES,
        timeoutMs: SESSION_DIFF_CAPTURE_TIMEOUT_MS,
      },
    });
    await this.deps.alarms.clear("execution");
    if (!sent) {
      this.deps.storage.transactionSync(() =>
        this.deps.store.failCapture(
          captureId,
          "Sandbox disconnected before capture",
          this.deps.now()
        )
      );
      await this.afterAttemptSettled();
    } else {
      await this.deps.alarms.schedule("diff_capture", now + SESSION_DIFF_CAPTURE_TIMEOUT_MS);
    }
  }

  async handleStageObject(request: Request): Promise<Response> {
    const body = await this.readJsonRecord(request);
    const captureId = this.readId(body?.captureId);
    const fileId = this.readId(body?.fileId);
    const sizeBytes = body?.sizeBytes;
    const sha256 = body?.sha256;
    if (
      !captureId ||
      !fileId ||
      typeof sizeBytes !== "number" ||
      !Number.isInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      sizeBytes > SESSION_DIFF_MAX_PATCH_BYTES ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(sha256)
    ) {
      return Response.json({ error: "Invalid diff object metadata" }, { status: 400 });
    }
    const sessionId = encodeURIComponent(this.deps.getPublicSessionId());
    const objectKey = `session-diffs/${sessionId}/${captureId}/${fileId}.patch`;
    const staged = this.deps.store.stageObject({
      captureId,
      fileId,
      objectKey,
      sizeBytes,
      sha256,
      now: this.deps.now(),
    });
    return staged
      ? Response.json({ objectKey })
      : Response.json({ error: "Diff capture is no longer active" }, { status: 409 });
  }

  async handleCommitObject(request: Request): Promise<Response> {
    const body = await this.readJsonRecord(request);
    const captureId = this.readId(body?.captureId);
    const fileId = this.readId(body?.fileId);
    if (!captureId || !fileId) {
      return Response.json({ error: "Invalid diff object identity" }, { status: 400 });
    }
    return this.deps.store.markObjectStaged(captureId, fileId)
      ? new Response(null, { status: 204 })
      : Response.json({ error: "Diff object was not staged" }, { status: 409 });
  }

  async handleAbandonObject(request: Request): Promise<Response> {
    const body = await this.readJsonRecord(request);
    const captureId = this.readId(body?.captureId);
    const fileId = this.readId(body?.fileId);
    if (!captureId || !fileId) {
      return Response.json({ error: "Invalid diff object identity" }, { status: 400 });
    }
    this.deps.store.abandonObject(captureId, fileId, this.deps.now());
    return new Response(null, { status: 204 });
  }

  async handleComplete(request: Request): Promise<Response> {
    const captureId = this.readId(new URL(request.url).searchParams.get("captureId"));
    if (!captureId) return Response.json({ error: "Invalid capture ID" }, { status: 400 });
    const parsed = diffCaptureCompleteRequestSchema.safeParse(await this.readJsonRecord(request));
    if (!parsed.success) {
      return Response.json({ error: "Invalid diff capture manifest" }, { status: 400 });
    }
    const repositories = this.deps.repository.getSessionRepositories().flatMap((repository) => {
      const baseSha = repository.row?.base_sha;
      return baseSha
        ? [
            {
              position: repository.position,
              repoOwner: repository.repoOwner,
              repoName: repository.repoName,
              baseSha,
            },
          ]
        : [];
    });
    const result = this.deps.storage.transactionSync(() =>
      this.deps.store.publishCapture(captureId, parsed.data, repositories, this.deps.now())
    );
    if (!result.ok) {
      if (this.deps.store.getPublicState().attempt.status !== "capturing") {
        await this.afterAttemptSettled();
      }
      return Response.json({ error: result.error }, { status: result.status });
    }
    await this.afterAttemptSettled();
    return Response.json({ revisionId: result.revisionId });
  }

  async handleFailed(request: Request): Promise<Response> {
    const captureId = this.readId(new URL(request.url).searchParams.get("captureId"));
    const parsed = diffCaptureFailureRequestSchema.safeParse(await this.readJsonRecord(request));
    if (!captureId || !parsed.success) {
      return Response.json({ error: "Invalid diff capture failure" }, { status: 400 });
    }
    const failed = this.deps.storage.transactionSync(() =>
      this.deps.store.failCapture(captureId, parsed.data.error, this.deps.now())
    );
    if (!failed) {
      return Response.json({ error: "Diff capture is no longer active" }, { status: 409 });
    }
    await this.afterAttemptSettled();
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
    return Response.json(result);
  }

  async handleRetry(): Promise<Response> {
    if (this.deps.store.isDeleted()) {
      return Response.json({ error: "Session was deleted" }, { status: 409 });
    }
    const state = this.deps.store.getPublicState();
    if (state.attempt.status !== "failed") {
      return Response.json({ error: "Only a failed diff capture can be retried" }, { status: 409 });
    }
    if (!this.deps.hasSandboxConnection()) {
      return Response.json({ error: "Sandbox is not connected" }, { status: 409 });
    }
    await this.beginCapture(`retry-${this.deps.generateId()}`);
    const next = this.deps.store.getPublicState();
    return next.attempt.status === "capturing"
      ? Response.json({ captureId: next.attempt.id }, { status: 202 })
      : Response.json({ error: "Diff capture could not be retried" }, { status: 409 });
  }

  async handleDelete(): Promise<Response> {
    const objectKeys = this.deps.storage.transactionSync(() =>
      this.deps.store.tombstoneForDeletion(this.deps.now())
    );
    await this.deps.alarms.clear("diff_capture");
    await this.deleteObjects(objectKeys);
    await this.syncCleanupAlarm(this.deps.store.getNextCleanupAt());
    return new Response(null, { status: 204 });
  }

  async maintain(): Promise<void> {
    const now = this.deps.now();
    const captureTimeoutAt = this.deps.store.getCaptureTimeoutAt(SESSION_DIFF_CAPTURE_TIMEOUT_MS);
    if (captureTimeoutAt != null && captureTimeoutAt <= now) {
      const state = this.deps.store.getPublicState();
      if (state.attempt.id) {
        this.deps.storage.transactionSync(() =>
          this.deps.store.failCapture(state.attempt.id!, "Diff capture timed out", now)
        );
        await this.afterAttemptSettled();
      }
    }
    await this.deleteObjects(this.deps.store.getCleanupObjects(now));

    const captureDeadline = this.deps.store.getCaptureTimeoutAt(SESSION_DIFF_CAPTURE_TIMEOUT_MS);
    if (captureDeadline != null && captureDeadline > now) {
      await this.deps.alarms.schedule("diff_capture", captureDeadline);
    } else {
      await this.deps.alarms.clear("diff_capture");
    }
    await this.syncCleanupAlarm();
  }

  private async afterAttemptSettled(): Promise<void> {
    await this.deps.alarms.clear("diff_capture");
    await this.syncCleanupAlarm();
    this.broadcastState(this.deps.now());
    await this.deps.processMessageQueue();
  }

  private broadcastState(
    updatedAt: number,
    attemptStatus = this.deps.store.getPublicState().attempt.status
  ): void {
    const state = this.deps.store.getPublicState();
    this.deps.broadcast({
      type: "diff_state_changed",
      attemptStatus,
      revisionId: state.current?.revisionId ?? null,
      updatedAt,
    });
  }

  private async syncCleanupAlarm(deadline = this.deps.store.getNextCleanupAt()): Promise<void> {
    if (deadline == null) await this.deps.alarms.clear("diff_cleanup");
    else await this.deps.alarms.schedule("diff_cleanup", deadline);
  }

  private async deleteObjects(objectKeys: string[]): Promise<void> {
    for (const objectKey of objectKeys) {
      try {
        await this.deps.deleteObject(objectKey);
        this.deps.store.forgetObject(objectKey);
      } catch (error) {
        this.deps.store.deferObjectCleanup(objectKey, this.deps.now());
        this.deps.log.warn("session_diff.cleanup_failed", {
          object_key: objectKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async readJsonRecord(request: Request): Promise<Record<string, unknown> | null> {
    try {
      const value = await request.json();
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private readId(value: unknown): string | null {
    return typeof value === "string" && /^[A-Za-z0-9._-]{1,200}$/.test(value) ? value : null;
  }
}
