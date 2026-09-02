/**
 * The platform surface one session runtime is built over: what a host must
 * supply for `createSessionRuntime` to assemble the collaborator graph. The
 * Cloudflare adapter is `createDurableObjectSessionPlatform`
 * (cloudflare/session-platform.ts); a Node host supplies the same record from
 * its own storage, sockets, and process facilities.
 */

import type { Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import type { SqlDatabase } from "../db/sql-database";
import type { AlarmScheduleStore } from "./alarm/scheduler";
import type { SqlStorage, TransactionSync } from "./sql-storage";

/** The host that owns the session's accepted sockets. */
export interface SocketHost {
  /** Adopt `ws` into the runtime, tagged so its identity survives a restart. */
  accept(ws: WebSocket, tags: string[]): void;
  /** The tags `ws` was accepted with. */
  tags(ws: WebSocket): string[];
  /** Every accepted socket, or only those carrying `tag`. */
  sockets(tag?: string): WebSocket[];
  /**
   * Answer `request` frames with `response` at the platform level, without
   * waking the runtime.
   */
  setAutoResponse(request: string, response: string): void;
}

export interface SessionPlatform {
  /**
   * The host's identity for this runtime. It stands in for the session id
   * until `init` writes the session row.
   */
  id: string;
  /** The session's own SQLite store. */
  sql: SqlStorage;
  /** Run `closure` atomically against `sql`. */
  transactionSync: TransactionSync;
  /** The global store, or null when the deployment has none bound. */
  db: SqlDatabase | null;
  /** The runtime's single scheduled wake-up. */
  alarmStore: AlarmScheduleStore;
  sockets: SocketHost;
  /**
   * Build the deferred-work port for this runtime. Takes the session-scoped
   * logger so failures of background work are attributed to the session.
   */
  createBackgroundTasks(log: Logger): BackgroundTasks;
}
