import type {
  ExternalCreateSessionRequest,
  ExternalEventChange,
  ExternalEventFeedQuery,
  ExternalFollowUpRequest,
  ExternalSessionListQuery,
} from "@open-inspect/shared/types/external-session-api";
import type {
  ExternalDiffListQuery,
  ExternalKeysetListQuery,
  ExternalListQuery,
} from "@open-inspect/shared/types/external-resources-api";
import type { ApiClient } from "./api-client.js";
import { CliError } from "./errors.js";

interface PollOptions {
  after?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
interface OperationsDependencies {
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 100;
const MAX_POLL_INTERVAL_MS = 30_000;

/** Implements session behavior once for both command and MCP adapters. */
export class Operations {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly api: ApiClient,
    dependencies: OperationsDependencies = {}
  ) {
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? abortableSleep;
  }

  createSession(input: ExternalCreateSessionRequest) {
    return this.api.createSession(input);
  }

  listRepositories(options?: ExternalListQuery) {
    return this.api.listRepositories(options);
  }

  listEnvironments(options?: ExternalListQuery) {
    return this.api.listEnvironments(options);
  }

  getEnvironment(id: string) {
    return this.api.getEnvironment(id);
  }

  listModels() {
    return this.api.listModels();
  }

  listSkills(options?: ExternalListQuery) {
    return this.api.listSkills(options);
  }

  listProviderAccounts(options?: ExternalListQuery) {
    return this.api.listProviderAccounts(options);
  }

  listSessions(options?: ExternalSessionListQuery & { signal?: AbortSignal }) {
    return this.api.listSessions(options);
  }
  getSession(id: string, signal?: AbortSignal) {
    return this.api.getSession(id, signal);
  }

  promptSession(id: string, input: ExternalFollowUpRequest) {
    return this.api.promptSession(id, input);
  }

  uploadAttachment(id: string, file: Blob, name: string, idempotencyKey?: string) {
    return this.api.uploadAttachment(id, file, name, idempotencyKey);
  }

  messages(id: string, options?: { limit?: number; cursor?: string }) {
    return this.api.messages(id, options);
  }

  artifacts(id: string, options?: ExternalKeysetListQuery) {
    return this.api.artifacts(id, options);
  }

  artifactContent(id: string, artifactId: string, options?: { offset?: number; limit?: number }) {
    return this.api.artifactContent(id, artifactId, options);
  }

  diff(id: string, options?: ExternalDiffListQuery) {
    return this.api.diff(id, options);
  }

  diffFile(
    id: string,
    revisionId: string,
    fileId: string,
    options?: { offset?: number; limit?: number }
  ) {
    return this.api.diffFile(id, revisionId, fileId, options);
  }

  pullRequests(id: string, options?: ExternalListQuery) {
    return this.api.pullRequests(id, options);
  }

  pullRequest(id: string, pullRequestId: string) {
    return this.api.pullRequest(id, pullRequestId);
  }

  children(id: string, options?: ExternalListQuery) {
    return this.api.children(id, options);
  }

  child(id: string, childId: string) {
    return this.api.child(id, childId);
  }

  promptChild(id: string, childId: string, input: { content: string; clientRequestId: string }) {
    return this.api.promptChild(id, childId, input);
  }

  stopSession(id: string) {
    return this.api.stopSession(id);
  }
  events(id: string, options?: ExternalEventFeedQuery & { signal?: AbortSignal }) {
    return this.api.events(id, options);
  }

  async *followEvents(id: string, options: PollOptions = {}): AsyncGenerator<ExternalEventChange> {
    const { interval, deadline } = this.pollSettings(options);
    let checkpoint = options.after;
    const revisions = new Map<string, number>();
    while (!options.signal?.aborted && this.now() <= deadline) {
      let snapshot;
      try {
        snapshot = await this.readEventSnapshot(id, checkpoint, options.signal);
      } catch (cause) {
        if (cause instanceof CliError && cause.kind === "expired") {
          checkpoint = undefined;
          continue;
        }
        if (!isRetryableFeedError(cause)) throw cause;
        await this.sleep(retryDelayMs(cause, interval), options.signal);
        continue;
      }
      checkpoint = snapshot.checkpoint;
      for (const change of snapshot.changes) {
        const eventId = change.kind === "upsert" ? change.event.id : change.eventId;
        const priorRevision = revisions.get(eventId);
        if (priorRevision !== undefined && change.revision <= priorRevision) continue;
        revisions.set(eventId, change.revision);
        yield change;
      }
      if (options.signal?.aborted) break;
      await this.sleep(interval, options.signal);
    }
    if (!options.signal?.aborted && this.now() > deadline)
      throw new CliError("timeout", "Event polling timed out");
  }

  private async readEventSnapshot(
    id: string,
    after?: number,
    signal?: AbortSignal
  ): Promise<{ changes: ExternalEventChange[]; checkpoint: number }> {
    const changes: ExternalEventChange[] = [];
    const visitedCursors = new Set<string>();
    let cursor: string | undefined;
    let checkpoint: number | undefined;
    let revision = after;
    do {
      const page = await this.api.events(id, cursor ? { cursor, signal } : { after, signal });
      if (checkpoint !== undefined && page.checkpoint !== checkpoint)
        throw new CliError("service", "Event pagination checkpoint changed between pages");
      checkpoint = page.checkpoint;
      if (page.changes.some((change) => change.revision > page.checkpoint))
        throw new CliError("service", "Event change revision exceeded the pinned checkpoint");
      if (after !== undefined) {
        for (const change of page.changes) {
          if (revision !== undefined && change.revision <= revision)
            throw new CliError(
              "service",
              "Incremental event revisions were not strictly increasing"
            );
          revision = change.revision;
        }
      }
      changes.push(...page.changes);
      if (!page.hasMore) return { changes, checkpoint: page.checkpoint };
      cursor = page.cursor;
      if (!cursor || visitedCursors.has(cursor))
        throw new CliError("service", "Event pagination returned a repeated or missing cursor");
      visitedCursors.add(cursor);
    } while (!signal?.aborted);
    throw signal?.reason ?? new CliError("timeout", "Event polling was aborted");
  }

  async wait(id: string, options: PollOptions = {}) {
    const { interval, deadline } = this.pollSettings(options);
    let latest: Awaited<ReturnType<ApiClient["waitStatus"]>> | undefined;
    while (true) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      const remaining = deadline - this.now();
      if (remaining <= 0) return timedOut(latest);

      const result = await withDeadline(
        (signal) => this.api.waitStatus(id, signal),
        remaining,
        options.signal
      ).catch((cause) => {
        if (options.signal?.aborted) throw abortReason(options.signal);
        if (cause instanceof WaitDeadlineError) return timedOut(latest);
        throw cause;
      });
      if (result.timedOut) return result;
      latest = result;
      if (result.settled) return result;

      const sleepMs = Math.min(interval, Math.max(0, deadline - this.now()));
      if (sleepMs === 0) return timedOut(latest);
      await this.sleep(sleepMs, options.signal);
    }
  }

  private pollSettings(options: PollOptions): { interval: number; deadline: number } {
    const interval = Math.min(
      MAX_POLL_INTERVAL_MS,
      Math.max(MIN_POLL_INTERVAL_MS, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    );
    const timeout = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return { interval, deadline: this.now() + timeout };
  }
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Operation aborted"));
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Operation aborted"));
      },
      { once: true }
    );
  });
}

function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  callerSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(abortReason(controller.signal)), {
      once: true,
    });
  });
  const abortFromCaller = () => {
    if (callerSignal) controller.abort(abortReason(callerSignal));
  };
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (callerSignal?.aborted) abortFromCaller();
  const timer = setTimeout(
    () => controller.abort(new WaitDeadlineError()),
    Math.ceil(milliseconds)
  );
  timer.unref();

  return Promise.race([operation(controller.signal), aborted]).finally(() => {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  });
}

class WaitDeadlineError extends Error {}

function timedOut<T extends { settled: boolean }>(latest: T | undefined): T & { timedOut: true } {
  if (!latest) throw new CliError("timeout", "Session wait timed out before a status was observed");
  return { ...latest, settled: false, timedOut: true };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted");
}

function isRetryableFeedError(cause: unknown): boolean {
  return (
    cause instanceof CliError &&
    (cause.kind === "transport" || cause.kind === "service" || cause.kind === "rate_limited")
  );
}

function retryDelayMs(cause: unknown, fallback: number): number {
  if (!(cause instanceof CliError) || cause.kind !== "rate_limited") return fallback;
  const seconds = Number(cause.context?.retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : fallback;
}
