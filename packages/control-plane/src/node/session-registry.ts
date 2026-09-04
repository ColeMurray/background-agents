/**
 * SessionRegistry — the Node host's counterpart to one Durable Object per
 * session: it opens a session runtime on first touch, keeps it resident
 * while something is happening, and retires it when nothing is.
 *
 * Per session the registry does what `SessionDO` does per activation: open
 * the session's store, build the platform record over the host's adapters,
 * build the runtime, publish it only once the whole graph exists (a throw
 * leaves nothing behind, so the next event retries), and rehydrate the
 * runtime's alarm unless this activation *is* an alarm delivery. Events
 * then reach the runtime through `withRuntime` and `deliverScheduledDeadline`,
 * and socket events through the host the registry binds to it.
 *
 * Residency reproduces the platform's economics. A runtime stays resident
 * while it has adopted sockets, running background tasks, or an event in
 * flight, and for `idleAfterMs` after its last activity; one whose next
 * deadline is within `deadlineHorizonMs` stays too, since the alarm would
 * only reopen it. Otherwise the sweep closes its store and drops it, and
 * the next event opens it again from the file. `maxResident` bounds memory:
 * opening beyond it retires the least recently active runtime that is
 * quiescent, and if none is, the bound is exceeded and logged rather than
 * enforced against live work. A runtime with open sockets is never retired
 * underneath them: the socket host and the runtime are a one-shot pair.
 *
 * Session files are the durable store. The registry creates one for any
 * well-formed id (existence is the caller's check, as the Worker checks the
 * index before reaching a Durable Object) and never deletes one; only an
 * explicit archive or delete route may.
 */

import type { Logger } from "../logger";
import type { SqlDatabase } from "../db/sql-database";
import type { AlarmScheduleStore } from "../session/alarm/scheduler";
import type { SessionPlatform } from "../session/platform";
import { createNodeBackgroundTasks, type NodeBackgroundTasks } from "./background-tasks";
import type { OwnedSessionStore, SessionStoreProvider } from "./session-store";
import {
  NodeWebSocketHost,
  type NodeSocketHostOptions,
  type SessionWebSocketEventSink,
} from "./socket-host";

/** How long a quiescent runtime stays resident after its last event. */
const DEFAULT_IDLE_AFTER_MS = 2 * 60_000;
/** A runtime whose next deadline is this close stays resident for it. */
const DEFAULT_DEADLINE_HORIZON_MS = 60_000;
/** How often the sweep looks for idle runtimes. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/** Resident runtimes before the registry starts retiring the least recently active. */
const DEFAULT_MAX_RESIDENT = 256;
/** The close code sent to sockets a shutdown retires: the peer should reconnect. */
export const SERVICE_RESTART_CLOSE_CODE = 1012;

/**
 * What the registry drives on a runtime: the session server's socket entry
 * points and deadline handler, and alarm rehydration. `SessionRuntime`
 * satisfies it; the registry does not name the composition root.
 */
export interface RegisteredSessionRuntime {
  readonly server: SessionWebSocketEventSink & { onScheduledDeadline(): Promise<void> };
  readonly alarms: { rehydrate(): void };
}

export interface SessionRegistryOptions<Runtime extends RegisteredSessionRuntime> {
  /** The deployment's global store, shared by every runtime. */
  db: SqlDatabase;
  stores: SessionStoreProvider;
  /** The session's alarm port, from the host alarm clock. */
  alarmStoreFor: (sessionId: string) => AlarmScheduleStore;
  /** The composition root, with the deployment's configuration already bound. */
  buildRuntime: (platform: SessionPlatform) => Runtime;
  log: Logger;
  now?: () => number;
  idleAfterMs?: number;
  deadlineHorizonMs?: number;
  sweepIntervalMs?: number;
  maxResident?: number;
  socketHost?: NodeSocketHostOptions;
}

interface ResidentSession<Runtime> {
  readonly id: string;
  readonly runtime: Runtime;
  readonly store: OwnedSessionStore;
  readonly sockets: NodeWebSocketHost;
  readonly alarmStore: AlarmScheduleStore;
  /** Created by the runtime through the platform record; empty until then. */
  readonly tasks: { current: NodeBackgroundTasks | null };
  lastActivity: number;
  /** Events (requests, socket deliveries, alarm deliveries) currently running. */
  inFlight: number;
  /** Set the moment the runtime leaves the registry; its store is closed. */
  retired: boolean;
}

type RetireReason = "idle" | "capacity" | "shutdown";

export class SessionRegistry<Runtime extends RegisteredSessionRuntime> {
  private readonly db: SqlDatabase;
  private readonly stores: SessionStoreProvider;
  private readonly alarmStoreFor: (sessionId: string) => AlarmScheduleStore;
  private readonly buildRuntime: (platform: SessionPlatform) => Runtime;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly idleAfterMs: number;
  private readonly deadlineHorizonMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxResident: number;
  private readonly socketHostOptions: NodeSocketHostOptions;
  private readonly resident = new Map<string, ResidentSession<Runtime>>();
  private readonly opening = new Map<string, Promise<ResidentSession<Runtime>>>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping: Promise<string[]> | null = null;
  private closed = false;

  constructor(options: SessionRegistryOptions<Runtime>) {
    this.db = options.db;
    this.stores = options.stores;
    this.alarmStoreFor = options.alarmStoreFor;
    this.buildRuntime = options.buildRuntime;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
    this.idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
    this.deadlineHorizonMs = options.deadlineHorizonMs ?? DEFAULT_DEADLINE_HORIZON_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.maxResident = options.maxResident ?? DEFAULT_MAX_RESIDENT;
    this.socketHostOptions = options.socketHost ?? {};
  }

  /**
   * Run `use` against the session's runtime, opening it first if it is not
   * resident. The call counts as activity for as long as it runs.
   */
  async withRuntime<T>(sessionId: string, use: (runtime: Runtime) => Promise<T>): Promise<T> {
    const session = await this.acquire(sessionId, true);
    return this.track(session, () => use(session.runtime));
  }

  /**
   * Deliver the session's scheduled deadline, the host alarm clock's
   * `deliver`. Opening for a delivery does not rehydrate the alarm: this
   * delivery is the alarm, as on the Durable Object.
   */
  async deliverScheduledDeadline(sessionId: string): Promise<void> {
    const session = await this.acquire(sessionId, false);
    await this.track(session, () => session.runtime.server.onScheduledDeadline());
  }

  /** The ids of the runtimes resident right now. */
  residentSessionIds(): string[] {
    return [...this.resident.keys()];
  }

  /** Run the idle sweep every `sweepIntervalMs` until `stop` or `close`. */
  start(): void {
    if (this.closed || this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.log.error("session_registry.sweep_failed", {
          error: error instanceof Error ? error : String(error),
        });
      });
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Retire every runtime that has been idle for `idleAfterMs` and has no
   * deadline within `deadlineHorizonMs`. Returns the ids retired. Sweeps do
   * not overlap: a call during a sweep joins it.
   */
  sweep(): Promise<string[]> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.sweepIdle().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  /**
   * Retire every resident runtime and refuse further opens: the last step
   * of a shutdown, after the host has closed the sockets and drained the
   * runtimes' background tasks. What is still open here is forced: sockets
   * are closed with 1012 so their peers reconnect to the next process, and
   * work still running is logged and abandoned with its store closed.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.stop();
    // Opens that passed the closed check finish building and publish, so
    // they are waited for and then retired like the rest.
    while (this.opening.size > 0) {
      await Promise.allSettled([...this.opening.values()]);
    }
    if (this.sweeping) await this.sweeping;
    for (const session of [...this.resident.values()]) {
      for (const socket of session.sockets.sockets()) {
        socket.close(SERVICE_RESTART_CLOSE_CODE, "Service restart");
      }
      if (!this.isQuiescent(session)) {
        this.log.warn("session_registry.retired_busy", {
          session_id: session.id,
          in_flight: session.inFlight,
          open_sockets: session.sockets.sockets().length,
          background_tasks: session.tasks.current?.size ?? 0,
        });
      }
      this.retire(session, "shutdown");
    }
  }

  /** The resident runtime, or a freshly opened one; never one already retired. */
  private async acquire(sessionId: string, rehydrate: boolean): Promise<ResidentSession<Runtime>> {
    for (;;) {
      const session = await this.open(sessionId, rehydrate);
      // A sweep may have retired the runtime between its lookup and this
      // resumption; nothing awaits between this check and the caller's
      // `track`, so a runtime that passes it is held.
      if (!session.retired) return session;
    }
  }

  /** Single-flight per id: concurrent opens of a cold session share one build. */
  private open(sessionId: string, rehydrate: boolean): Promise<ResidentSession<Runtime>> {
    const resident = this.resident.get(sessionId);
    if (resident) return Promise.resolve(resident);
    const opening = this.opening.get(sessionId);
    if (opening) return opening;
    const attempt = this.build(sessionId, rehydrate).finally(() => {
      this.opening.delete(sessionId);
    });
    this.opening.set(sessionId, attempt);
    return attempt;
  }

  private async build(sessionId: string, rehydrate: boolean): Promise<ResidentSession<Runtime>> {
    if (this.closed) throw new Error("SessionRegistry is closed");
    const startedAt = performance.now();
    this.makeRoom();
    const store = await this.stores.open(sessionId);
    try {
      const session = this.assemble(sessionId, store);
      this.resident.set(sessionId, session);
      this.log.info("session_registry.opened", {
        session_id: sessionId,
        duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
        resident: this.resident.size,
      });
      if (rehydrate) session.runtime.alarms.rehydrate();
      return session;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  /** Build the platform record and the runtime over it; nothing is published here. */
  private assemble(sessionId: string, store: OwnedSessionStore): ResidentSession<Runtime> {
    const sockets = new NodeWebSocketHost(this.log, this.socketHostOptions);
    const alarmStore = this.alarmStoreFor(sessionId);
    const tasks: ResidentSession<Runtime>["tasks"] = { current: null };
    const platform: SessionPlatform = {
      id: sessionId,
      storage: store.storage,
      db: this.db,
      alarmStore,
      sockets,
      createBackgroundTasks: (log) => {
        tasks.current = createNodeBackgroundTasks(log);
        return tasks.current;
      },
    };
    const runtime = this.buildRuntime(platform);
    const session: ResidentSession<Runtime> = {
      id: sessionId,
      runtime,
      store,
      sockets,
      alarmStore,
      tasks,
      lastActivity: this.now(),
      inFlight: 0,
      retired: false,
    };
    // Bound before any socket can be adopted: adoption goes through the
    // runtime, which did not exist until this point.
    sockets.bindEventSink({
      onMessage: (ws, message) => this.track(session, () => runtime.server.onMessage(ws, message)),
      onClose: (ws, code, reason, wasClean) =>
        this.track(session, () => runtime.server.onClose(ws, code, reason, wasClean)),
      onError: (ws, error) => {
        session.lastActivity = this.now();
        runtime.server.onError(ws, error);
      },
    });
    return session;
  }

  /** Run one event against the runtime, holding it resident meanwhile. */
  private async track<T>(session: ResidentSession<Runtime>, event: () => Promise<T>): Promise<T> {
    session.inFlight += 1;
    session.lastActivity = this.now();
    try {
      return await event();
    } finally {
      session.inFlight -= 1;
      session.lastActivity = this.now();
    }
  }

  /** Nothing is happening in the runtime: no sockets, no events, no background tasks. */
  private isQuiescent(session: ResidentSession<Runtime>): boolean {
    return (
      session.inFlight === 0 &&
      session.sockets.sockets().length === 0 &&
      (session.tasks.current?.size ?? 0) === 0
    );
  }

  private isIdle(session: ResidentSession<Runtime>, now: number): boolean {
    return this.isQuiescent(session) && now - session.lastActivity >= this.idleAfterMs;
  }

  private async sweepIdle(): Promise<string[]> {
    const retired: string[] = [];
    for (const session of [...this.resident.values()]) {
      if (!this.isIdle(session, this.now())) continue;
      let deadline: number | null;
      try {
        deadline = await session.alarmStore.getAlarm();
      } catch (error) {
        this.log.error("session_registry.deadline_unreadable", {
          session_id: session.id,
          error: error instanceof Error ? error : String(error),
        });
        continue;
      }
      const now = this.now();
      if (deadline !== null && deadline - now <= this.deadlineHorizonMs) continue;
      // The read above yielded; an event may have arrived meanwhile.
      if (session.retired || !this.isIdle(session, now)) continue;
      this.retire(session, "idle");
      retired.push(session.id);
    }
    return retired;
  }

  /**
   * Make room for one more runtime under `maxResident` by retiring the
   * least recently active quiescent one. Deadlines are not consulted: a
   * runtime retired ahead of its alarm is simply reopened by the delivery.
   */
  private makeRoom(): void {
    while (this.resident.size >= this.maxResident) {
      let victim: ResidentSession<Runtime> | null = null;
      for (const session of this.resident.values()) {
        if (!this.isQuiescent(session)) continue;
        if (victim === null || session.lastActivity < victim.lastActivity) victim = session;
      }
      if (victim === null) {
        this.log.warn("session_registry.resident_cap_exceeded", {
          max_resident: this.maxResident,
          resident: this.resident.size,
        });
        return;
      }
      this.retire(victim, "capacity");
    }
  }

  /** Leave the registry and close the store, exactly once. */
  private retire(session: ResidentSession<Runtime>, reason: RetireReason): void {
    if (session.retired) return;
    session.retired = true;
    this.resident.delete(session.id);
    try {
      // Closing the last connection checkpoints the WAL into the file.
      session.store.close();
    } catch (error) {
      this.log.error("session_registry.store_close_failed", {
        session_id: session.id,
        error: error instanceof Error ? error : String(error),
      });
    }
    this.log.info("session_registry.retired", {
      session_id: session.id,
      reason,
      resident: this.resident.size,
    });
  }
}
