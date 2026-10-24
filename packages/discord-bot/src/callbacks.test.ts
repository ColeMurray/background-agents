import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { extractAgentResponse } from "@open-inspect/shared/completion/extractor";
import type * as extractorModule from "@open-inspect/shared/completion/extractor";
import { DISCORD_PUBLICATION_STOPPED_MAX_AGE_MS } from "@open-inspect/shared/types/session-api";
import app from "./index";
import { PUBLICATION_STOPPED_TEXT, recordStep } from "./progress";
import { createEnv, createKv } from "./test-helpers";
import type { Env } from "./types";

vi.mock("@open-inspect/shared/completion/extractor", async (importOriginal) => ({
  ...(await importOriginal<typeof extractorModule>()),
  extractAgentResponse: vi.fn(),
}));

const extract = vi.mocked(extractAgentResponse);
const discordFetch = vi.fn();
const statusMessage = { id: "status-1", startedAt: 1 };
const context = {
  source: "discord",
  channelId: "channel-1",
  threadId: "thread-1",
  userId: "user-1",
  repoFullName: "octo/repo",
  model: "anthropic/claude-opus-5",
  statusMessage,
};
const complete = () => ({
  sessionId: "s1",
  messageId: "m1",
  timestamp: Date.now(),
  success: true,
  context,
});
const step = () => ({
  sessionId: "s1",
  callId: "call-1",
  timestamp: Date.now(),
  tool: "Bash",
  args: { command: "npm test" },
  context,
});
const stopped = () => ({
  kind: "discord.publication_stopped",
  sessionId: "s1",
  timestamp: Date.now(),
  context: { channelId: "channel-1", threadId: "thread-1", statusMessage },
});
const routes = [
  ["complete", complete],
  ["tool_call", step],
  ["publication_stopped", stopped],
] as const;

beforeEach(() => {
  vi.stubGlobal("fetch", discordFetch);
  discordFetch.mockImplementation(async () => new Response(JSON.stringify({ id: "message-1" })));
  extract.mockResolvedValue({
    textContent: "Finished work",
    artifacts: [],
    toolCalls: [],
    mediaArtifacts: [],
    fileArtifacts: [],
    success: true,
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function signed(payload: Record<string, unknown>) {
  return { ...payload, signature: await computeHmacHex(JSON.stringify(payload), "secret") };
}

async function post(path: string, payload: unknown, env = createEnv(), traceId?: string) {
  return postRaw(path, JSON.stringify(payload), env, traceId);
}

async function postRaw(path: string, body: string, env = createEnv(), traceId?: string) {
  const pending: Promise<unknown>[] = [];
  const response = await app.fetch(
    new Request(`https://bot/callbacks/${path}`, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        ...(traceId ? { "x-trace-id": traceId } : {}),
      },
    }),
    env,
    {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext
  );
  await Promise.all(pending);
  return response;
}

function requestLogs() {
  return [console.log, console.warn, console.error]
    .flatMap((method) =>
      vi
        .mocked(method)
        .mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    )
    .filter((record) => record.msg === "http.request");
}

function discordEdits() {
  return discordFetch.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: init.method,
    body: init.body ? JSON.parse(init.body) : {},
  }));
}

describe.each(routes)("/callbacks/%s authentication", (route, payload) => {
  it("accepts the actual raw-object HMAC signature", async () => {
    const response = await post(route, await signed(payload()), createEnv(), "trace-raw");
    expect(response.status).toBe(200);
    expect(requestLogs()).toContainEqual(
      expect.objectContaining({
        trace_id: "trace-raw",
        http_path: `/callbacks/${route}`,
        http_status: 200,
        duration_ms: expect.any(Number),
      })
    );
  });

  it("reports a missing signing secret as configuration failure", async () => {
    const response = await post(
      route,
      await signed(payload()),
      createEnv({ SERVICE_AUTH_SECRET: undefined })
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "not configured" });
    expect(discordFetch).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(requestLogs()[0]).toMatchObject({ http_status: 500, duration_ms: expect.any(Number) });
  });

  it("rejects bad or missing signatures", async () => {
    for (const body of [payload(), { ...payload(), signature: "bad" }]) {
      const response = await post(route, body);
      expect(response.status).toBe(401);
    }
    expect(discordFetch).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(requestLogs()[0]).toMatchObject({ http_status: 401, duration_ms: expect.any(Number) });
  });

  it("returns controlled 400 for malformed JSON and authentic malformed payloads", async () => {
    for (const response of [
      await postRaw(route, "{"),
      await post(route, await signed({ timestamp: Date.now() })),
    ]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid payload" });
    }
    expect(discordFetch).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it("verifies before schema normalization, never a trimmed object", async () => {
    const raw = { ...payload(), sessionId: " s1 " };
    expect((await post(route, await signed(raw))).status).toBe(200);
    const altered = { ...(await signed(payload())), sessionId: " s1 " };
    expect((await post(route, altered)).status).toBe(401);
  });

  it("rejects authentic extra properties instead of stripping them", async () => {
    const response = await post(route, await signed({ ...payload(), content: "not allowed" }));
    expect(response.status).toBe(400);
    expect(discordFetch).not.toHaveBeenCalled();
  });
});

describe("completion and tool callbacks", () => {
  it("threads the incoming trace into completion reads and completion logs", async () => {
    await post("complete", await signed(complete()), createEnv(), "trace-completion");
    expect(extract).toHaveBeenCalledWith(expect.anything(), "s1", "m1", "trace-completion");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"trace_id":"trace-completion"')
    );
    expect(discordEdits().some((call) => call.body.content?.includes("Finished work"))).toBe(true);
  });

  it("generates a trace when none is supplied", async () => {
    await post("complete", await signed(complete()));
    expect(extract.mock.calls[0][3]).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestLogs()[0].trace_id).toBe(extract.mock.calls[0][3]);
  });

  it("accepts callbacks even when task launch configuration is invalid", async () => {
    expect(
      (
        await post(
          "complete",
          await signed(complete()),
          createEnv({ HARNESS: "bad", DEFAULT_MODEL: "bad" })
        )
      ).status
    ).toBe(200);
    expect(extract).toHaveBeenCalledOnce();
  });

  it("does nothing for tool callbacks without a status message", async () => {
    const { statusMessage: _status, ...withoutStatus } = context;
    expect(
      (await post("tool_call", await signed({ ...step(), context: withoutStatus }))).status
    ).toBe(200);
    expect(discordFetch).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });
});

describe("publication stopped", () => {
  it("persists the marker before success and edits only the existing status", async () => {
    const kv = createKv();
    const env = createEnv({ DISCORD_KV: kv as unknown as KVNamespace });
    discordFetch.mockImplementation(async () => {
      expect(kv.store.get("status-finished:status-1")).toBe(PUBLICATION_STOPPED_TEXT);
      return new Response(JSON.stringify({ id: "status-1" }));
    });
    const response = await post("publication_stopped", await signed(stopped()), env);
    expect(response.status).toBe(200);
    expect(discordEdits()).toEqual([
      {
        url: expect.stringContaining("/channels/thread-1/messages/status-1"),
        method: "PATCH",
        body: expect.objectContaining({ content: PUBLICATION_STOPPED_TEXT }),
      },
    ]);
    expect(extract).not.toHaveBeenCalled();
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
  });

  it("does not post content when no status message exists", async () => {
    const payload = { ...stopped(), context: { channelId: "channel-1" } };
    expect((await post("publication_stopped", await signed(payload))).status).toBe(200);
    expect(discordFetch).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it.each([-1, 1])("rejects timestamps outside the freshness window (%s)", async (direction) => {
    const payload = {
      ...stopped(),
      timestamp: Date.now() + direction * (DISCORD_PUBLICATION_STOPPED_MAX_AGE_MS + 10_000),
    };
    expect((await post("publication_stopped", await signed(payload))).status).toBe(400);
    expect(discordFetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...stopped(), context: { ...stopped().context, repoFullName: "private/repo" } },
    {
      ...stopped(),
      context: { ...stopped().context, statusMessage: { ...statusMessage, content: "private" } },
    },
    { ...stopped(), kind: "discord.complete" },
  ])("rejects a different signing domain or nested content", async (payload) => {
    expect((await post("publication_stopped", await signed(payload))).status).toBe(400);
    expect(discordFetch).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it("returns retryable failure without editing when the marker write fails", async () => {
    const kv = createKv();
    kv.put.mockRejectedValueOnce(new Error("KV down"));
    expect(
      (
        await post(
          "publication_stopped",
          await signed(stopped()),
          createEnv({ DISCORD_KV: kv as unknown as KVNamespace })
        )
      ).status
    ).toBe(503);
    expect(discordFetch).not.toHaveBeenCalled();
  });

  it("retains the marker after an edit failure and lets a late step repair the text", async () => {
    const env: Env = createEnv();
    discordFetch.mockResolvedValueOnce(new Response("down", { status: 500 }));
    expect((await post("publication_stopped", await signed(stopped()), env)).status).toBe(503);
    expect(await env.DISCORD_KV.get("status-finished:status-1")).toBe(PUBLICATION_STOPPED_TEXT);
    await recordStep(env, {
      channelId: "thread-1",
      statusMessage,
      tool: "Bash",
      args: { command: "private work" },
    });
    expect(discordEdits().at(-1)!.body.content).toBe(PUBLICATION_STOPPED_TEXT);
    expect(discordEdits().every((call) => call.method === "PATCH")).toBe(true);
    expect(extract).not.toHaveBeenCalled();
  });

  it("permits a retry to repair a failed stop edit", async () => {
    const env = createEnv();
    const payload = await signed(stopped());
    discordFetch.mockResolvedValueOnce(new Response("down", { status: 500 }));
    expect((await post("publication_stopped", payload, env)).status).toBe(503);
    expect((await post("publication_stopped", payload, env)).status).toBe(200);
    expect(discordEdits().at(-1)!.body.content).toBe(PUBLICATION_STOPPED_TEXT);
  });
});
