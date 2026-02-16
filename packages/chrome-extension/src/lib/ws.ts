import { getWsUrl } from "@/lib/storage";
import { fetchWsToken } from "@/lib/api";
import { WS_CLOSE_AUTH_REQUIRED, WS_CLOSE_SESSION_EXPIRED } from "@/lib/constants";
import type { ServerMessage } from "@open-inspect/shared";

// re-export for convenience
export type { ServerMessage };

interface WsManagerOptions {
  sessionId: string;
  onMessage: (data: ServerMessage) => void;
  onConnected: () => void;
  onDisconnected: (reason: "auth" | "expired" | "error" | "clean") => void;
  onConnecting: () => void;
}

/**
 * manages a websocket connection to the control plane for a single session.
 * handles auth token fetching, subscription, reconnection, and ping keepalive.
 */
export class SessionWsManager {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private subscribed = false;
  private opts: WsManagerOptions;

  constructor(opts: WsManagerOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.destroyed) return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.opts.onConnecting();

    // fetch ws auth token if we don't have one
    if (!this.token) {
      try {
        this.token = await fetchWsToken(this.opts.sessionId);
      } catch {
        this.opts.onDisconnected("auth");
        return;
      }
    }

    const wsBaseUrl = await getWsUrl();
    const wsUrl = `${wsBaseUrl}/sessions/${this.opts.sessionId}/ws`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (this.destroyed) {
        ws.close();
        return;
      }
      this.reconnectAttempts = 0;
      this.opts.onConnected();

      // subscribe
      ws.send(
        JSON.stringify({
          type: "subscribe",
          token: this.token,
          clientId: crypto.randomUUID(),
        })
      );

      // start keepalive pings
      this.pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30_000);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as ServerMessage;
        if (data.type === "subscribed") {
          this.subscribed = true;
        }
        this.opts.onMessage(data);
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = (event) => {
      this.cleanup();

      if (event.code === WS_CLOSE_AUTH_REQUIRED) {
        this.token = null;
        this.opts.onDisconnected("auth");
        return;
      }
      if (event.code === WS_CLOSE_SESSION_EXPIRED) {
        this.token = null;
        this.opts.onDisconnected("expired");
        return;
      }

      if (!this.destroyed && !event.wasClean && this.reconnectAttempts < 5) {
        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
        this.reconnectAttempts++;
        this.reconnectTimeout = setTimeout(() => this.connect(), delay);
      } else if (!event.wasClean) {
        this.opts.onDisconnected("error");
      } else {
        this.opts.onDisconnected("clean");
      }
    };

    ws.onerror = () => {
      // onerror is always followed by onclose
    };
  }

  send(data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.subscribed) return;
    this.ws.send(JSON.stringify(data));
  }

  sendPrompt(content: string, model?: string, reasoningEffort?: string): void {
    this.send({ type: "prompt", content, model, reasoningEffort });
  }

  stop(): void {
    this.send({ type: "stop" });
  }

  destroy(): void {
    this.destroyed = true;
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private cleanup(): void {
    this.subscribed = false;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.ws = null;
  }
}
