import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { createNodeHttpServer, type HealthReport } from "./http-server";

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

describe("createNodeHttpServer", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    server = null;
  });

  async function listen(options: Parameters<typeof createNodeHttpServer>[0]): Promise<string> {
    server = createNodeHttpServer(options);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("answers /healthz itself, 200 while serving and 503 while draining", async () => {
    const health = vi.fn(() => report("ok"));
    const fetchApp = vi.fn(async () => new Response("app"));
    const base = await listen({ fetch: fetchApp, upgrade: vi.fn(), health });

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
      upgrade: vi.fn(),
      health: () => report("ok"),
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
    const base = await listen({ fetch: vi.fn(), upgrade, health: () => report("ok") });
    const ws = new NodeWebSocket(`${base.replace("http", "ws")}/sessions/s1/ws`);
    const message = await new Promise<string>((resolve) =>
      ws.once("error", (error) => resolve(error.message))
    );
    expect(message).toBe("Unexpected server response: 418");
    expect(upgrade).toHaveBeenCalledTimes(1);
  });
});
