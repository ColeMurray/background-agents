import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import type { Logger } from "../logger";
import { createNodeHttpServer, type HealthReport, type NodeHttpServer } from "./http-server";

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function report(status: HealthReport["status"]): HealthReport {
  return {
    status,
    uptime_s: 1,
    migrations_applied: 74,
    sessions_resident: 0,
    background_tasks: 0,
    alarm_clock: "running",
    cron: "running",
  };
}

type Options = Parameters<typeof createNodeHttpServer>[0];

describe("createNodeHttpServer", () => {
  let http: NodeHttpServer | null = null;
  let log: Logger;

  afterEach(async () => {
    if (!http) return;
    http.server.closeAllConnections();
    http.server.close();
    await once(http.server, "close");
    http = null;
  });

  async function listen(options: Partial<Options>): Promise<string> {
    log = fakeLogger();
    http = createNodeHttpServer({
      fetch: vi.fn(async () => new Response("app")),
      upgrade: vi.fn(async () => {}),
      health: () => report("ok"),
      log,
      ...options,
    });
    http.server.listen(0, "127.0.0.1");
    await once(http.server, "listening");
    return `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  }

  it("answers /healthz itself, 200 while serving and 503 while draining", async () => {
    const health = vi.fn(() => report("ok"));
    const fetchApp = vi.fn(async () => new Response("app"));
    const base = await listen({ fetch: fetchApp, health });

    const ok = await fetch(`${base}/healthz`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual(report("ok"));

    health.mockReturnValue(report("draining"));
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    expect(fetchApp).not.toHaveBeenCalled();

    // Only reads are the host's; anything else on the path is the app's.
    const posted = await fetch(`${base}/healthz`, { method: "POST" });
    expect(await posted.text()).toBe("app");
  });

  it("hands every other request to the app as a fetch Request", async () => {
    const seen: Request[] = [];
    const base = await listen({
      fetch: async (request) => {
        seen.push(request);
        return Response.json({ body: await request.text() }, { status: 201 });
      },
    });
    const response = await fetch(`${base}/sessions?x=1`, {
      method: "POST",
      body: "payload",
      headers: { "x-trace-id": "t1" },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ body: "payload" });
    expect(seen[0].url).toBe(`${base}/sessions?x=1`);
    expect(seen[0].headers.get("x-trace-id")).toBe("t1");
  });

  it("routes an upgrade to the upgrade handler", async () => {
    const upgrade = vi.fn(async (_request, socket) => {
      socket.end("HTTP/1.1 418 I'm a teapot\r\nConnection: close\r\n\r\n");
    });
    const base = await listen({ upgrade });
    const ws = new NodeWebSocket(`${base.replace("http", "ws")}/sessions/s1/ws`);
    const message = await new Promise<string>((resolve) =>
      ws.once("error", (error) => resolve(error.message))
    );
    expect(message).toBe("Unexpected server response: 418");
    expect(upgrade).toHaveBeenCalledTimes(1);
  });

  it("logs a rejecting upgrade handler and destroys the socket instead of leaking the rejection", async () => {
    const base = await listen({
      upgrade: vi.fn(async () => {
        throw new Error("index unavailable");
      }),
    });
    const ws = new NodeWebSocket(`${base.replace("http", "ws")}/sessions/s1/ws`);
    const failure = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(failure.message).toMatch(/socket hang up|ECONNRESET/);
    expect(log.error).toHaveBeenCalledWith(
      "WebSocket upgrade path failed",
      expect.objectContaining({ event: "ws.upgrade_failed", http_path: "/sessions/s1/ws" })
    );
  });

  it("tracks requests in flight and drains them within a budget", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = await listen({
      fetch: async () => {
        await held;
        return new Response("done");
      },
    });
    const server = http!;
    expect(server.inFlight).toBe(0);
    const response = fetch(`${base}/slow`);
    await vi.waitFor(() => expect(server.inFlight).toBe(1));

    // Still held at a short budget: reported, not waited for.
    expect(await server.drain(20)).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      "http.drain_timeout",
      expect.objectContaining({ pending: 1 })
    );

    const drained = server.drain(5_000);
    release();
    expect(await drained).toBe(0);
    expect(await (await response).text()).toBe("done");
    expect(server.inFlight).toBe(0);
  });

  it("stops tracking a request whose handler rejected", async () => {
    const base = await listen({
      fetch: async () => {
        throw new Error("handler exploded");
      },
    });
    const response = await fetch(`${base}/boom`);
    expect(response.status).toBe(500);
    expect(http!.inFlight).toBe(0);
  });
});
