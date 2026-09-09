/**
 * Session Durable Object: the Cloudflare adapter for one session runtime.
 *
 * All application wiring lives in `createSessionRuntime` (session/components.ts),
 * which returns the narrow surface this class needs — the server entry points,
 * the session logger, and alarm rehydration. This class only initializes the
 * runtime per activation and forwards the platform callbacks.
 */

import { DurableObject } from "cloudflare:workers";
import { initSchema } from "../session/schema";
import type { Env } from "../types";
import { createDurableObjectSessionPlatform } from "./session-platform";
import { createCloudflareEnv, type WorkerBindings } from "./platform";
import { upgradeWebSocket } from "./websocket-upgrade";
import type { SessionPlatform } from "../session/platform";
import { createSessionRuntime, type SessionRuntime } from "../session/components";

export class SessionDO extends DurableObject<WorkerBindings> {
  /**
   * This object's storage, sockets, alarm, and event lifetime as the ports
   * the runtime is built over, with the deployment's global store. The
   * constructor is the single point where env.DB is read; a missing binding
   * fails construction instead of running a degraded session.
   */
  private readonly platform: SessionPlatform;
  /** The application environment over this object's bindings. */
  private readonly appEnv: Env;
  // The per-activation runtime; null until ensureInitialized() builds it.
  private _runtime: SessionRuntime | null = null;

  constructor(ctx: DurableObjectState, env: WorkerBindings) {
    super(ctx, env);
    // eslint-disable-next-line no-restricted-syntax -- composition root input: the DO's one env.DB read
    const db = env.DB;
    if (!db) {
      throw new Error(
        "SessionDO requires the DB binding; sessions cannot run without the global store"
      );
    }
    this.platform = createDurableObjectSessionPlatform(ctx, db);
    this.appEnv = createCloudflareEnv(env);
  }

  /** The runtime, (re)built on first touch after construction or eviction. */
  private get runtime(): SessionRuntime {
    this.ensureInitialized();
    return this._runtime!;
  }

  /**
   * Initialize the session runtime: apply the schema, then build the whole
   * collaborator graph eagerly. Every platform entry point calls this first.
   */
  private ensureInitialized(rehydrateAlarm = true): void {
    if (this._runtime) return;
    const initStart = performance.now();
    initSchema(this.platform.storage.sql);
    const runtime = createSessionRuntime(this.platform, this.appEnv);
    // Publish only after the graph is fully built: a throw above leaves the
    // activation uninitialized, so the next event retries initialization
    // instead of dereferencing an undefined runtime.
    this._runtime = runtime;
    runtime.log.info("do.init", {
      event: "do.init",
      duration_ms: Math.round((performance.now() - initStart) * 100) / 100,
    });
    if (rehydrateAlarm) {
      runtime.alarms.rehydrate();
    }
  }

  /**
   * Handle incoming HTTP requests. WebSocket upgrades are completed here,
   * on the Cloudflare side of the session, because only the host can turn
   * an admitted upgrade into a socket.
   */
  async fetch(request: Request): Promise<Response> {
    const runtime = this.runtime;
    if (request.headers.get("Upgrade") === "websocket") {
      return upgradeWebSocket(runtime.upgrades, request, runtime.log);
    }
    return runtime.server.onRequest(request);
  }

  /**
   * Handle WebSocket message (with hibernation support).
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.runtime.server.onMessage(ws, message);
  }

  /**
   * Handle WebSocket close.
   */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    await this.runtime.server.onClose(ws, code, reason, wasClean);
  }

  /**
   * Handle WebSocket error.
   */
  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    this.runtime.server.onError(ws, error);
  }

  /**
   * Durable Object alarm handler. Initializes without re-arming the alarm —
   * this delivery is the alarm — then delegates deadline handling.
   */
  async alarm(): Promise<void> {
    this.ensureInitialized(false);
    await this._runtime!.server.onScheduledDeadline();
  }
}
