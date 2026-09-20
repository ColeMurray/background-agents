import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { verifyCallbackSignature } from "@open-inspect/shared/auth";
import type { SessionCallbackJob } from "@open-inspect/shared/types/session-callback-jobs";
import { COMPLETION_JOB, LINEAR_CONTEXT, SLACK_CONTEXT } from "../../test/callback-fixtures";
import type { JobDeps } from "../jobs";
import { createLogger } from "../logger";
import { handleSessionCallback } from "../session/callback-job-consumer";
import type { Env } from "../types";
import { createUrlFetchClient } from "./url-fetch-client";

const servers: Server[] = [];
async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe("URL-backed bot client", () => {
  it.each(["string", "URL", "Request", "Request override"])(
    "preserves native body-bearing keepalive semantics for %s input",
    async (form) => {
      const origin = await listen(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        res.end(Buffer.concat(chunks));
      });
      const body = "unchanged ü body";
      const init = { method: "POST", body, keepalive: true };
      const nativeResponse = await fetch(`${origin}/native`, init);
      expect(await nativeResponse.text()).toBe(body);
      const input =
        form === "URL"
          ? new URL("https://internal/callback")
          : form.startsWith("Request")
            ? new Request("https://internal/callback", init)
            : "https://internal/callback";
      const response = await createUrlFetchClient(origin).fetch(
        input,
        form === "Request"
          ? undefined
          : form === "Request override"
            ? { body: "replacement" }
            : init
      );
      expect(await response.text()).toBe(form === "Request override" ? "replacement" : body);
    }
  );

  it.each(["string", "URL", "Request", "relative", "configured"])(
    "preserves method, query, headers and body for %s input",
    async (form) => {
      const origin = await listen(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            url: req.url,
            method: req.method,
            header: req.headers["x-test"],
            host: req.headers.host,
            body: Buffer.concat(chunks).toString(),
          })
        );
      });
      const path = "/callbacks/complete?b=%2F&a=1&a=2";
      const body = '{"value":"ü","signature":"unchanged"}';
      const init = { method: "POST", headers: { "x-test": "kept", host: "foreign.invalid" }, body };
      const input =
        form === "Request"
          ? new Request(`https://internal${path}`, init)
          : form === "URL"
            ? new URL(`https://internal${path}`)
            : form === "relative"
              ? path
              : form === "configured"
                ? `${origin}${path}`
                : `https://internal${path}`;
      const response = await createUrlFetchClient(origin).fetch(
        input,
        form === "Request" ? undefined : init
      );
      expect(await response.json()).toEqual({
        url: path,
        method: "POST",
        header: "kept",
        host: new URL(origin).host,
        body,
      });
    }
  );

  it("honors RequestInit overrides and keeps double-slash paths on the configured host", async () => {
    const origin = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.end(
        JSON.stringify({
          path: req.url,
          method: req.method,
          body: Buffer.concat(chunks).toString(),
        })
      );
    });
    const response = await createUrlFetchClient(origin).fetch(
      new Request("https://internal//foreign.invalid/path", { method: "POST", body: "old" }),
      { method: "PUT", body: "new" }
    );
    expect(await response.json()).toEqual({
      path: "//foreign.invalid/path",
      method: "PUT",
      body: "new",
    });
  });

  it.each([
    "bad",
    "http://bots.example",
    "https://user:secret@bots.example",
    "https://bots.example/prefix",
    "https://bots.example?token=secret",
    "https://bots.example#fragment",
    "file:///tmp/bot",
  ])("rejects invalid configuration without echoing credentials: %s", (url) => {
    expect(() => createUrlFetchClient(url)).toThrow(/Bot URL/);
    try {
      createUrlFetchClient(url);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
  it.each([
    "https://bots.example",
    "http://localhost:1234",
    "http://127.0.0.1:1234",
    "http://[::1]:1234",
  ])("accepts supported origin %s", (url) => {
    expect(() => createUrlFetchClient(url)).not.toThrow();
  });
  it("refuses foreign request origins", async () => {
    await expect(
      createUrlFetchClient("https://bots.example").fetch("https://foreign.invalid/path")
    ).rejects.toThrow(/origin/);
  });
  it("rejects redirects even when the caller requests follow, without forwarding signed bodies", async () => {
    let forwarded = 0;
    const target = await listen((_req, res) => {
      forwarded++;
      res.end("unexpected");
    });
    const origin = await listen((_req, res) => {
      res.writeHead(307, { location: target });
      res.end();
    });
    await expect(
      createUrlFetchClient(origin).fetch("/callback", {
        method: "POST",
        body: "signed",
        redirect: "follow",
      })
    ).rejects.toThrow();
    expect(forwarded).toBe(0);
  });
  it("honors the caller deadline while waiting for headers", async () => {
    const origin = await listen(() => {});
    await expect(
      createUrlFetchClient(origin).fetch("/hang", { signal: AbortSignal.timeout(50) })
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("keeps the caller deadline active while reading the body", async () => {
    const origin = await listen((_req, res) => {
      res.writeHead(200);
      res.write("partial");
    });
    const response = await createUrlFetchClient(origin).fetch("/stream", {
      signal: AbortSignal.timeout(200),
    });
    await expect(response.text()).rejects.toThrow();
  });
  it("preserves caller cancellation", async () => {
    const controller = new AbortController();
    const origin = await listen(() => controller.abort());
    await expect(
      createUrlFetchClient(origin).fetch(
        new Request("https://internal/hang", { signal: controller.signal })
      )
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("real callback consumer over the URL transport", () => {
  const toolJob: SessionCallbackJob = {
    version: 1,
    type: "slack.tool_call",
    payload: {
      sessionId: "session-1",
      timestamp: 1000,
      tool: "bash",
      args: {},
      callId: "call-1",
      context: SLACK_CONTEXT,
    },
  };
  const startJob: SessionCallbackJob = {
    version: 1,
    type: "linear.started",
    payload: {
      sessionId: "session-1",
      messageId: "message-1",
      timestamp: 1000,
      context: LINEAR_CONTEXT,
    },
  };
  it.each([
    [COMPLETION_JOB, "complete", "slack-key"],
    [toolJob, "tool_call", "slack-key"],
    [startJob, "start", "linear-key"],
  ] as const)("delivers signed %j without changing producer time", async (job, endpoint, key) => {
    let received: { body: Record<string, unknown>; path: string | undefined } | undefined;
    const origin = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = { body: JSON.parse(Buffer.concat(chunks).toString()), path: req.url };
      res.end("ok");
    });
    const deps = callbackDeps(origin);
    expect(await handleSessionCallback(job, { attempts: 1, maxAttempts: 13 }, deps)).toBe("ack");
    expect(received?.path).toBe(`/callbacks/${endpoint}`);
    expect(received?.body.timestamp).toBe(job.payload.timestamp);
    expect(
      await verifyCallbackSignature(
        received!.body as Parameters<typeof verifyCallbackSignature>[0],
        key
      )
    ).toBe(true);
  });
  it("leaves retries to the job policy and cosmetic failures are acknowledged", async () => {
    let calls = 0;
    const origin = await listen((_req, res) => {
      calls++;
      res.writeHead(503);
      res.end();
    });
    const deps = callbackDeps(origin);
    expect(
      await handleSessionCallback(COMPLETION_JOB, { attempts: 1, maxAttempts: 13 }, deps)
    ).toEqual({ retry: true });
    expect(calls).toBe(1);
    expect(await handleSessionCallback(toolJob, { attempts: 1, maxAttempts: 13 }, deps)).toBe(
      "ack"
    );
    expect(calls).toBe(2);
  });
});

function callbackDeps(origin: string): JobDeps {
  return {
    env: {
      SLACK_BOT: createUrlFetchClient(origin),
      LINEAR_BOT: createUrlFetchClient(origin),
      SERVICE_AUTH_SECRET_SLACK_BOT: "slack-key",
      SERVICE_AUTH_SECRET_LINEAR_BOT: "linear-key",
    } as unknown as Env,
    db: {} as JobDeps["db"],
    log: createLogger("test", {}, "error"),
    correlation: { trace_id: "trace", request_id: "request" },
  };
}
