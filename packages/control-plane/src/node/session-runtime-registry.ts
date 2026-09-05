/**
 * SessionRuntimeRegistry — the Node host's counterpart to one Durable
 * Object per session: it opens a session runtime on first touch, keeps it
 * resident while something is happening, and retires it when nothing is.
 *
 * Per session the registry does what `SessionDO` does per activation: open
 * the session's store, build the platform record over the host's adapters,
 * build the runtime, publish it only once the whole graph exists (a throw
 * leaves nothing behind, so the next event retries), and rehydrate the
 * runtime's alarm unless an alarm delivery joined the activation. Events
 * then reach the runtime through `withRuntime` and `deliverScheduledDeadline`,
 * and socket events through the host the registry binds to it.
 *
 * A runtime is `opening`, `resident`, `quiescing` (shutdown), or `retired`.
 * Only the transitions are serialized: every event on a runtime holds an
 * activity lease, taken in the same continuation that checks the runtime
 * is resident, so a runtime with a lease is never retired underneath it.
 *
 * Residency reproduces the platform's economics. A runtime stays resident
 * while it has adopted sockets, running background tasks, or a lease held,
 * and for `idleAfterMs` after its last activity; one whose next deadline is
 * within `deadlineHorizonMs` stays too, since the alarm would only reopen
 * it. Otherwise the sweep closes its store and drops it, and the next event
 * opens it again from the file. `maxResident` bounds memory: publishing
 * beyond it retires the least recently active quiescent runtime, and if
 * none is, the bound is exceeded and logged rather than enforced against
 * live work. A runtime with open sockets is never retired underneath them:
 * the socket host and the runtime are a one-shot pair.
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
/** How long a shutdown waits for every runtime to quiesce before forcing it. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
/** The close code sent to sockets a shutdown closes: the peer should reconnect. */
export const SERVICE_RESTART_CLOSE_CODE = 1012;

/**
 * What the registry drives on a runtime: the session server's socket entry
 * points and deadline handler, and alarm rehydration. `SessionRuntime`
 * satisfies it; the registry does not name the composition root.
 */
export interface ManagedSessionRuntime {
  readonly server: SessionWebSocketEventSink & { onScheduledDeadline(): Promise<void> };
  readonly alarms: { rehydrate(): void };
}

export interface SessionRuntimeRegistryOptions<Runtime extends ManagedSessionRuntime> {
  /** The deployment's global store, shared by every runtime. */
  db: SqlDatabase;
  storeProvider: SessionStoreProvider;
  /** The deployment's session index; `SessionIndexStore` satisfies it. */
  sessionIndex: SessionIndex;
  /** The session's alarm port, from the host alarm clock. */
  alarmStoreFor: (sessionId: string) => AlarmScheduleStore;
  /** The composition root, with the deployment's configuration already bound. */
  buildRuntime: (platform: SessionPlatform) => Runtime;
  log: Logger;
  /** The activity clock; idle time is measured on it. */
  nowMs?: () => number;
  idleAfterMs?: number;
  deadlineHorizonMs?: number;
  sweepIntervalMs?: number;
  maxResident?: number;
  socketHostOptions?: NodeSocketHostOptions;
}

/** Whether the deployment knows the session at all. */
export interface SessionIndex {
  exists(sessionId: string): Promise<boolean>;
}

export interface ShutdownOptions {
  /** Wall-clock budget for every runtime to quiesce before it is forced. */
  timeoutMs?: number;
}

type ResidencyState = "resident" | "quiescing" | "retired";

interface ResidentSession<Runtime> {
  readonly id: string;
  readonly runtime: Runtime;
  readonly store: OwnedSessionStore;
  readonly sockets: NodeWebSocketHost;
  readonly alarmStore: AlarmScheduleStore;
  /** Created by the runtime through the platform record; empty until then. */
  readonly tasks: { current: NodeBackgroundTasks | null };
  state: ResidencyState;
  lastActivityAtMs: number;
  /** Events (requests, socket deliveries, alarm deliveries) holding the runtime. */
  activeLeases: number;
  /** Shutdown waiting for the runtime to quiesce; woken on every release. */
  quiescenceWaiters: Array<() => void>;
}

/** What the events sharing an activation need of it, settled when it publishes. */
interface ActivationIntent {
  /**
   * Whether the activation rehydrates the alarm. A joining alarm delivery
   * clears it: the delivery is the alarm, and rehydrating would re-arm the
   * claimed deadline the host index has already taken.
   */
  rehydrate: boolean;
  /**
   * Events waiting on the activation. Each holds a lease from the moment
   * the runtime publishes, so nothing can retire it before they run.
   */
  waiters: number;
}

/** A build in progress; `null` when it found no session behind the id. */
interface Opening<Runtime> {
  promise: Promise<Acquired<Runtime> | null>;
  intent: ActivationIntent;
}

/** A runtime found by `open`, and whether the caller's lease was pre-taken at publish. */
interface Acquired<Runtime> {
  session: ResidentSession<Runtime>;
  leased: boolean;
}

type RetireReason = "idle" | "capacity" | "shutdown" | "activation_failed";

export class SessionRuntimeRegistry<Runtime extends ManagedSessionRuntime> {
  private readonly db: SqlDatabase;
  private readonly storeProvider: SessionStoreProvider;
  private readonly sessionIndex: SessionIndex;
  private readonly alarmStoreFor: (sessionId: string) => AlarmScheduleStore;
  private readonly buildRuntime: (platform: SessionPlatform) => Runtime;
  private readonly log: Logger;
  private readonly nowMs: () => number;
  private readonly idleAfterMs: number;
  private readonly deadlineHorizonMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxResident: number;
  private readonly socketHostOptions: NodeSocketHostOptions;
  private readonly resident = new Map<string, ResidentSession<Runtime>>();
  private readonly opening = new Map<string, Opening<Runtime>>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping: Promise<string[]> | null = null;
  private shuttingDown = false;

  constructor(options: SessionRuntimeRegistryOptions<Runtime>) {
    this.db = options.db;
    this.storeProvider = options.storeProvider;
    this.sessionIndex = options.sessionIndex;
    this.alarmStoreFor = options.alarmStoreFor;
    this.buildRuntime = options.buildRuntime;
    this.log = options.log;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
    this.deadlineHorizonMs = options.deadlineHorizonMs ?? DEFAULT_DEADLINE_HORIZON_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.maxResident = options.maxResident ?? DEFAULT_MAX_RESIDENT;
    this.socketHostOptions = options.socketHostOptions ?? {};
  }

  /**
   * Run `use` against the session's runtime, opening it first if it is not
   * resident. The runtime is leased for as long as `use` runs.
   */
  async withRuntime<T>(sessionId: string, use: (runtime: Runtime) => Promise<T>): Promise<T> {
    const session = await this.acquireLease(sessionId, true, false);
    return this.runUnderLease(session, () => use(session.runtime));
  }

  /**
   * `withRuntime` for a session that must already exist: one with a store
   * on this host or a row in the session index (the row is written before
   * the session's init request, so a session being created counts). The
   * check runs inside the single-flight open, so nothing is built for an
   * unknown id, and `undefined` reports that nothing is behind it.
   */
  async withRuntimeIfPresent<T>(
    sessionId: string,
    use: (runtime: Runtime) => Promise<T>
  ): Promise<T | undefined> {
    const session = await this.acquireLease(sessionId, true, true);
    if (!session) return undefined;
    return this.runUnderLease(session, () => use(session.runtime));
  }

  /**
   * Deliver the session's scheduled deadline, the host alarm clock's
   * `deliver`. An activation this delivery starts or joins does not
   * rehydrate the alarm: this delivery is the alarm, as on the Durable Object.
   */
  async deliverScheduledDeadline(sessionId: string): Promise<void> {
    const session = await this.acquireLease(sessionId, false, false);
    await this.runUnderLease(session, () => session.runtime.server.onScheduledDeadline());
  }

  /** The ids of the runtimes resident right now. */
  residentSessionIds(): string[] {
    return [...this.resident.keys()];
  }

  /** Run the idle sweep every `sweepIntervalMs` until `stopSweeper` or `shutdown`. */
  startSweeper(): void {
    if (this.shuttingDown || this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.log.error("session_registry.sweep_failed", {
          error: error instanceof Error ? error : String(error),
        });
      });
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  stopSweeper(): void {
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
   * Quiesce and retire every runtime, then refuse further leases. Per
   * runtime, in order: new leases are refused, adopted sockets are closed
   * with 1012 so their peers reconnect to the next process, and the
   * runtime's leases (including those close deliveries) and background
   * tasks are waited for; only then is its store closed. A runtime still
   * busy at the budget is logged and forced.
   */
  async shutdown(options: ShutdownOptions = {}): Promise<void> {
    const deadlineMs = Date.now() + (options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    this.shuttingDown = true;
    this.stopSweeper();
    // Builds in progress finish and publish (their events were leased before
    // the shutdown began), so they are waited for and retired like the rest.
    while (this.opening.size > 0) {
      await Promise.allSettled([...this.opening.values()].map((o) => o.promise));
    }
    if (this.sweeping) await this.sweeping;
    await Promise.all(
      [...this.resident.values()].map((session) => this.quiesce(session, deadlineMs))
    );
  }

  private async quiesce(session: ResidentSession<Runtime>, deadlineMs: number): Promise<void> {
    session.state = "quiescing";
    const quiescent = await this.waitForQuiescence(session, deadlineMs);
    if (!quiescent) {
      this.log.warn("session_registry.retired_busy", {
        session_id: session.id,
        active_leases: session.activeLeases,
        open_sockets: session.sockets.sockets().length,
        background_tasks: session.tasks.current?.size ?? 0,
      });
    }
    this.retire(session, "shutdown");
  }

  /**
   * Whether the runtime reached quiescence before `deadlineMs` (wall clock).
   * Every pass closes the sockets the runtime holds: a lease taken before
   * the shutdown began (an upgrade being authorized, say) may still adopt
   * one, and it must be closed like those that were there at the start.
   */
  private async waitForQuiescence(
    session: ResidentSession<Runtime>,
    deadlineMs: number
  ): Promise<boolean> {
    for (;;) {
      for (const socket of session.sockets.sockets()) {
        socket.close(SERVICE_RESTART_CLOSE_CODE, "Service restart");
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) return this.isQuiescent(session);
      const tasks = session.tasks.current;
      if (tasks && tasks.size > 0) {
        await tasks.drain(remainingMs);
        continue;
      }
      if (this.isQuiescent(session)) return true;
      // Woken by the next lease release (a socket's close delivery among
      // them) or by the budget, whichever comes first.
      await new Promise<void>((wake) => {
        const timer = setTimeout(wake, remainingMs);
        session.quiescenceWaiters.push(() => {
          clearTimeout(timer);
          wake();
        });
      });
    }
  }

  /**
   * The resident runtime, or a freshly opened one, leased: either the
   * lease was pre-taken when the runtime published, or it is taken in the
   * same continuation that saw the runtime resident, so nothing can retire
   * it between the check and the lease. Refused once a shutdown has begun.
   * With `ifPresent`, `undefined` when no session exists behind the id.
   */
  private acquireLease(
    sessionId: string,
    rehydrate: boolean,
    ifPresent: false
  ): Promise<ResidentSession<Runtime>>;
  private acquireLease(
    sessionId: string,
    rehydrate: boolean,
    ifPresent: true
  ): Promise<ResidentSession<Runtime> | undefined>;
  private async acquireLease(
    sessionId: string,
    rehydrate: boolean,
    ifPresent: boolean
  ): Promise<ResidentSession<Runtime> | undefined> {
    for (;;) {
      const acquired = await this.open(sessionId, rehydrate, ifPresent);
      if (!acquired) {
        // A conditional open found nothing; an unconditional caller that
        // joined it builds on its own turn.
        if (ifPresent) return undefined;
        continue;
      }
      const { session, leased } = acquired;
      if (this.shuttingDown || session.state === "quiescing") {
        if (leased) this.release(session);
        throw new Error("SessionRuntimeRegistry is shutting down");
      }
      if (session.state !== "resident") continue;
      if (!leased) this.takeLease(session);
      return session;
    }
  }

  private takeLease(session: ResidentSession<Runtime>): void {
    session.activeLeases += 1;
    session.lastActivityAtMs = this.nowMs();
  }

  private release(session: ResidentSession<Runtime>): void {
    session.activeLeases -= 1;
    session.lastActivityAtMs = this.nowMs();
    for (const wake of session.quiescenceWaiters.splice(0)) wake();
  }

  /** Run `event`, releasing the lease the caller holds once it settles. */
  private async runUnderLease<T>(
    session: ResidentSession<Runtime>,
    event: () => Promise<T>
  ): Promise<T> {
    try {
      return await event();
    } finally {
      this.release(session);
    }
  }

  /** Single-flight per id: events that find a build in progress join it. */
  private open(
    sessionId: string,
    rehydrate: boolean,
    ifPresent: boolean
  ): Promise<Acquired<Runtime> | null> {
    const resident = this.resident.get(sessionId);
    if (resident) return Promise.resolve({ session: resident, leased: false });
    const opening = this.opening.get(sessionId);
    if (opening) {
      opening.intent.rehydrate &&= rehydrate;
      opening.intent.waiters += 1;
      return opening.promise;
    }
    if (this.shuttingDown) {
      return Promise.reject(new Error("SessionRuntimeRegistry is shutting down"));
    }
    const intent: ActivationIntent = { rehydrate, waiters: 1 };
    const promise = this.buildIf(sessionId, intent, ifPresent)
      .then((session) => (session ? { session, leased: true } : null))
      .finally(() => {
        this.opening.delete(sessionId);
      });
    this.opening.set(sessionId, { promise, intent });
    return promise;
  }

  /** `build`, unless `ifPresent` and nothing on this host or in the index knows the id. */
  private async buildIf(
    sessionId: string,
    intent: ActivationIntent,
    ifPresent: boolean
  ): Promise<ResidentSession<Runtime> | null> {
    if (ifPresent && !(await this.isPresent(sessionId))) return null;
    return this.build(sessionId, intent);
  }

  private async isPresent(sessionId: string): Promise<boolean> {
    return (
      (await this.storeProvider.exists(sessionId)) || (await this.sessionIndex.exists(sessionId))
    );
  }

  private async build(
    sessionId: string,
    intent: ActivationIntent
  ): Promise<ResidentSession<Runtime>> {
    const startedAt = performance.now();
    const store = await this.storeProvider.open(sessionId);
    let session: ResidentSession<Runtime>;
    try {
      session = this.assemble(sessionId, store);
    } catch (error) {
      store.close();
      throw error;
    }
    // Admission and publication in one continuation: capacity is taken
    // from what is resident now, by a build that has already succeeded,
    // and the runtime publishes already leased by every event waiting on it.
    this.makeRoom();
    session.activeLeases = intent.waiters;
    this.resident.set(sessionId, session);
    this.log.info("session_registry.opened", {
      session_id: sessionId,
      duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
      resident: this.resident.size,
    });
    try {
      if (intent.rehydrate) session.runtime.alarms.rehydrate();
    } catch (error) {
      // The activation failed after publication: the waiters get the error
      // rather than the runtime, so their leases are dropped with it.
      session.activeLeases = 0;
      this.retire(session, "activation_failed");
      throw error;
    }
    return session;
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
      state: "resident",
      lastActivityAtMs: this.nowMs(),
      activeLeases: 0,
      quiescenceWaiters: [],
    };
    // Bound before any socket can be adopted: adoption goes through the
    // runtime, which did not exist until this point. A socket's events are
    // leased on arrival; an open socket keeps the runtime resident, so the
    // runtime is there to receive them.
    const leased = (event: () => Promise<void>): Promise<void> => {
      this.takeLease(session);
      return this.runUnderLease(session, event);
    };
    sockets.bindEventSink({
      onMessage: (ws, message) => leased(() => runtime.server.onMessage(ws, message)),
      onClose: (ws, code, reason, wasClean) =>
        leased(() => runtime.server.onClose(ws, code, reason, wasClean)),
      onError: (ws, error) => {
        session.lastActivityAtMs = this.nowMs();
        runtime.server.onError(ws, error);
      },
    });
    return session;
  }

  /** Nothing is happening in the runtime: no sockets, no leases, no background tasks. */
  private isQuiescent(session: ResidentSession<Runtime>): boolean {
    return (
      session.activeLeases === 0 &&
      session.sockets.sockets().length === 0 &&
      (session.tasks.current?.size ?? 0) === 0
    );
  }

  private isIdle(session: ResidentSession<Runtime>, nowMs: number): boolean {
    return this.isQuiescent(session) && nowMs - session.lastActivityAtMs >= this.idleAfterMs;
  }

  private async sweepIdle(): Promise<string[]> {
    const retired: string[] = [];
    for (const session of [...this.resident.values()]) {
      if (!this.isIdle(session, this.nowMs())) continue;
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
      const nowMs = this.nowMs();
      if (deadline !== null && deadline - nowMs <= this.deadlineHorizonMs) continue;
      // The read above yielded; a lease may have been taken meanwhile.
      if (session.state !== "resident" || !this.isIdle(session, nowMs)) continue;
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
        if (session.state !== "resident" || !this.isQuiescent(session)) continue;
        if (victim === null || session.lastActivityAtMs < victim.lastActivityAtMs) {
          victim = session;
        }
      }
      if (victim === null) {
        this.log.warn("session_registry.resident_cap_exceeded", {
          max_resident: this.maxResident,
          resident: this.resident.size + 1,
        });
        return;
      }
      this.retire(victim, "capacity");
    }
  }

  /** Leave the registry and close the store, exactly once. */
  private retire(session: ResidentSession<Runtime>, reason: RetireReason): void {
    if (session.state === "retired") return;
    session.state = "retired";
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
