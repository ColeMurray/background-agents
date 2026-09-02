import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, json } from "../http/responses";
import { TEST_SERVICE_SECRETS } from "../router.test-support";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { defineRoute, NO_AUTHORIZATION, type Route } from "../routes/shared";
import type { Env } from "../types";
import { createControlPlaneApp, type ControlPlaneHost } from "./hono-app";

const PUBLIC = { authentication: { kind: "public" }, supportedScmProviders: "all" } as const;

function publicRoute(path: string, handler: Route["handler"]): Route {
  return defineRoute(PUBLIC, { method: "GET", path, authorization: NO_AUTHORIZATION, handler });
}

const tasks = createTestBackgroundTasks();
const host: ControlPlaneHost = { backgroundTasks: () => tasks };
const env = { DB: {}, ...TEST_SERVICE_SECRETS } as unknown as Env;

function loggedEvents(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map(
    (call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("control-plane Hono app lifecycle", () => {
  it("refuses a response from a handler that admission did not precede", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createControlPlaneApp(
      [publicRoute("/admitted", async () => json({ ok: true }))],
      host
    );
    // A route registered outside the catalog carries no admit() middleware.
    app.get("/open", (c) => c.text("open", 200, { "Set-Cookie": "leak=1" }));

    const admitted = await app.fetch(new Request("https://cp.test/admitted"), env);
    expect(admitted.status).toBe(200);

    const open = await app.fetch(new Request("https://cp.test/open"), env);
    expect(open.status).toBe(500);
    await expect(open.json()).resolves.toEqual({ error: "Internal server error" });
    expect(open.headers.get("Set-Cookie")).toBeNull();
    expect(open.headers.get("x-request-id")).toBeTruthy();
    expect(loggedEvents(errors).map((line) => line.event)).toEqual(["router.unadmitted_response"]);
  });

  it("answers preflight and unknown paths without a route policy", async () => {
    const app = createControlPlaneApp(
      [publicRoute("/admitted", async () => json({ ok: true }))],
      host
    );

    const preflight = await app.fetch(
      new Request("https://cp.test/admitted", { method: "OPTIONS" }),
      env
    );
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");

    const miss = await app.fetch(new Request("https://cp.test/missing"), env);
    expect(miss.status).toBe(404);
    await expect(miss.json()).resolves.toEqual({ error: "Not found" });
    expect(miss.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const head = await app.fetch(new Request("https://cp.test/admitted", { method: "HEAD" }), env);
    expect(head.status).toBe(404);
  });

  it("maps handler failures to the JSON envelope and logs unexpected ones as 500", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const app = createControlPlaneApp(
      [
        publicRoute("/teapot", async () => {
          throw new HttpError("I am a teapot", 418);
        }),
        publicRoute("/boom", async () => {
          throw new Error("boom");
        }),
        publicRoute("/thrown-string", async () => {
          throw "not an Error";
        }),
      ],
      host
    );

    const teapot = await app.fetch(new Request("https://cp.test/teapot"), env);
    expect(teapot.status).toBe(418);
    await expect(teapot.json()).resolves.toEqual({ error: "I am a teapot" });

    const boom = await app.fetch(new Request("https://cp.test/boom"), env);
    expect(boom.status).toBe(500);
    await expect(boom.json()).resolves.toEqual({ error: "Internal server error" });
    expect(boom.headers.get("x-trace-id")).toBeTruthy();

    const thrown = await app.fetch(new Request("https://cp.test/thrown-string"), env);
    expect(thrown.status).toBe(500);
    await expect(thrown.json()).resolves.toEqual({ error: "Internal server error" });

    const errorLines = loggedEvents(errors).filter((line) => line.event === "http.request");
    expect(errorLines.map((line) => line.http_path)).toEqual(["/boom", "/thrown-string"]);
    const infoLines = loggedEvents(info).filter((line) => line.event === "http.request");
    expect(infoLines.map((line) => [line.http_path, line.http_status])).toEqual([["/teapot", 418]]);
  });

  it("finalizes a failure inside admission with the route's response policy", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const route: Route = {
      ...publicRoute("/sessions/:id/tunnel-urls", async () => json({ ok: true })),
      authentication: {
        kind: "sandbox",
        getSessionId: () => {
          throw new Error("identity lookup failed");
        },
      },
      cacheControl: "no-store",
    };
    const app = createControlPlaneApp([route], host);

    const response = await app.fetch(new Request("https://cp.test/sessions/s-1/tunnel-urls"), env);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-trace-id")).toBeTruthy();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(loggedEvents(errors).map((line) => [line.event, line.http_status])).toEqual([
      ["http.request", 500],
    ]);
  });

  it("refuses a route that declares the same parameter twice", () => {
    expect(() =>
      createControlPlaneApp([publicRoute("/parents/:id/children/:id", async () => json({}))], host)
    ).toThrow("Route declares parameter :id twice");
  });

  it("refuses to build a principal-less route that requires authorization", () => {
    const route = {
      ...publicRoute("/broken", async () => json({})),
      authorization: { kind: "authenticated", auditAllowed: false },
    } as Route;
    expect(() => createControlPlaneApp([route], host)).toThrow(
      "Route without a verified principal cannot require authorization"
    );
  });

  it("refuses a route path outside the literal-or-parameter grammar", () => {
    expect(() =>
      createControlPlaneApp([publicRoute("/files/*", async () => json({}))], host)
    ).toThrow("outside the supported grammar");
  });
});
