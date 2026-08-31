import type {
  ExternalCreateSessionRequest,
  ExternalEventChange,
  ExternalEventFeedQuery,
  ExternalFollowUpRequest,
} from "@open-inspect/shared/types/external-session-api";
import type { ApiClient } from "./api-client.js";
import { CliError } from "./errors.js";

interface PollOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
interface OperationsDependencies {
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
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

  listSessions(signal?: AbortSignal) {
    return this.api.listSessions(signal);
  }
  getSession(id: string, signal?: AbortSignal) {
    return this.api.getSession(id, signal);
  }

  promptSession(id: string, input: ExternalFollowUpRequest) {
    return this.api.promptSession(id, input);
  }

  stopSession(id: string) {
    return this.api.stopSession(id);
  }
  events(id: string, options?: ExternalEventFeedQuery & { signal?: AbortSignal }) {
    return this.api.events(id, options);
  }

  async *followEvents(id: string, options: PollOptions = {}): AsyncGenerator<ExternalEventChange> {
    const { interval, deadline } = this.pollSettings(options);
    let checkpoint: number | undefined;
    while (!options.signal?.aborted && this.now() <= deadline) {
      let snapshot;
      try {
        snapshot = await this.readEventSnapshot(id, checkpoint, options.signal);
      } catch (cause) {
        if (!isRetryableFeedError(cause)) throw cause;
        await this.sleep(interval, options.signal);
        continue;
      }
      checkpoint = snapshot.checkpoint;
      for (const change of snapshot.changes) yield change;
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

  async wait(id: string, options: PollOptions = {}): Promise<unknown> {
    const { interval, deadline } = this.pollSettings(options);
    while (!options.signal?.aborted && this.now() <= deadline) {
      const result = await this.api.waitStatus(id, options.signal);
      if (result.settled) return result;
      await this.sleep(interval, options.signal);
    }
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Operation aborted");
    throw new CliError("timeout", "Session wait timed out");
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

function isRetryableFeedError(cause: unknown): boolean {
  return (
    cause instanceof CliError &&
    (cause.kind === "transport" || cause.kind === "service" || cause.kind === "rate_limited")
  );
}
