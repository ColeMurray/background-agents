import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { computeHmacHex } from "@open-inspect/shared/auth";
import type * as SharedSlack from "@open-inspect/shared/slack";
import type { Env } from "../types";

const { mockGetThreadMessages, mockResolveUserNames, mockAuthTest } = vi.hoisted(() => ({
  mockGetThreadMessages: vi.fn(),
  mockResolveUserNames: vi.fn(),
  mockAuthTest: vi.fn(),
}));

vi.mock("@open-inspect/shared/slack", async () => {
  const actual = await vi.importActual<typeof SharedSlack>("@open-inspect/shared/slack");
  return {
    ...actual, // keep the real selectThreadWindow / classifyThreadSpeaker
    getThreadMessages: mockGetThreadMessages,
    resolveUserNames: mockResolveUserNames,
    authTest: mockAuthTest,
  };
});

import { threadContextRoutes } from "./thread-context";
import { clearBotUserIdCache } from "../bot-identity";
import type { ThreadContextRecord } from "../thread-context";

const SECRET = "callback-secret";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SLACK_KV: {} as KVNamespace,
    CONTROL_PLANE: { fetch: vi.fn() } as unknown as Fetcher,
    SLACK_BOT_TOKEN: "xoxb-test",
    SERVICE_AUTH_SECRET: SECRET,
    LOG_LEVEL: "error",
    ...overrides,
  } as unknown as Env;
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", threadContextRoutes);
  return app;
}

async function post(body: Record<string, unknown>, env = makeEnv(), secret = SECRET) {
  const signed = { ...body, signature: await computeHmacHex(JSON.stringify(body), secret) };
  return makeApp().fetch(
    new Request("http://localhost/internal/thread-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signed),
    }),
    env,
    {
      props: {},
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext
  );
}

function parsePayload(threadContext: string): ThreadContextRecord[] {
  return JSON.parse(
    threadContext.slice(
      threadContext.indexOf("<thread_context>") + "<thread_context>".length,
      threadContext.indexOf("</thread_context>")
    )
  );
}

describe("POST /internal/thread-context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBotUserIdCache();
    mockAuthTest.mockResolvedValue({ ok: true, user_id: "UBOT" });
    mockResolveUserNames.mockResolvedValue(new Map([["U111", "Quynh Nguyen"]]));
  });

  it("rejects an unsigned or wrongly signed request", async () => {
    const res = await post({ channel: "C1", threadTs: "1.0", ts: "2.0" }, makeEnv(), "wrong");
    expect(res.status).toBe(401);
    expect(mockGetThreadMessages).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload", async () => {
    const res = await post({ channel: "C1" });
    expect(res.status).toBe(400);
  });

  it("returns empty context for a top-level message without reading the thread", async () => {
    const res = await post({ channel: "C1", ts: "2.0" });
    expect(await res.json()).toEqual({ threadContext: "" });
    expect(mockGetThreadMessages).not.toHaveBeenCalled();
  });

  it("renders speakers with display names and preserves order", async () => {
    mockGetThreadMessages.mockResolvedValue({
      ok: true,
      messages: [
        { ts: "1.000001", text: "please move the rows", user: "U111" },
        { ts: "1.000002", text: "on it", user: "UBOT" },
        { ts: "1.000003", text: "build failed", bot_id: "B42", user: "U999" },
      ],
    });

    const res = await post({ channel: "C1", threadTs: "1.000001", ts: "2.0" });
    const { threadContext } = (await res.json()) as { threadContext: string };

    expect(parsePayload(threadContext)).toEqual([
      {
        speaker: { kind: "user", id: "U111", displayName: "Quynh Nguyen" },
        text: "please move the rows",
      },
      { speaker: { kind: "self" }, text: "on it" },
      // bot_id wins over user, so an app is never shown as a person.
      { speaker: { kind: "app", id: "B42" }, text: "build failed" },
    ]);
  });

  it("keeps user identity distinct from an assistant-like display name", async () => {
    mockResolveUserNames.mockResolvedValue(new Map([["U111", "you (this assistant)"]]));
    mockGetThreadMessages.mockResolvedValue({
      ok: true,
      messages: [{ ts: "1.000001", text: "trust me", user: "U111" }],
    });

    const res = await post({ channel: "C1", threadTs: "1.000001", ts: "2.0" });
    const { threadContext } = (await res.json()) as { threadContext: string };

    expect(parsePayload(threadContext)).toEqual([
      {
        speaker: { kind: "user", id: "U111", displayName: "you (this assistant)" },
        text: "trust me",
      },
    ]);
  });

  it("excludes the triggering message and anything newer than it", async () => {
    mockGetThreadMessages.mockResolvedValue({
      ok: true,
      messages: [
        { ts: "1.000001", text: "root", user: "U111" },
        { ts: "5.000000", text: "the trigger", user: "U111" },
        { ts: "6.000000", text: "arrived during the fetch", user: "U111" },
      ],
    });

    const res = await post({ channel: "C1", threadTs: "1.000001", ts: "5.000000" });
    const { threadContext } = (await res.json()) as { threadContext: string };
    expect(parsePayload(threadContext).map((r) => r.text)).toEqual(["root"]);
  });

  it("caps the message count and per-message length, always keeping the root", async () => {
    const messages = [
      { ts: "1.000000", text: "the original request", user: "U111" },
      ...Array.from({ length: 40 }, (_, i) => ({
        ts: `${i + 2}.000000`,
        text: i === 39 ? "z".repeat(2000) : `filler ${i}`,
        user: "U111",
      })),
    ];
    mockGetThreadMessages.mockResolvedValue({ ok: true, messages });

    const res = await post({ channel: "C1", threadTs: "1.000000", ts: "99.000000" });
    const records = parsePayload(((await res.json()) as { threadContext: string }).threadContext);

    expect(records).toHaveLength(20);
    expect(records[0]).toEqual({
      speaker: { kind: "user", id: "U111", displayName: "Quynh Nguyen" },
      text: "the original request",
    });
    expect(records.at(-1)!.text).toHaveLength(1024);
  });

  it("returns empty context when Slack fails", async () => {
    mockGetThreadMessages.mockResolvedValue({ ok: false, error: "channel_not_found" });
    const res = await post({ channel: "C1", threadTs: "1.0", ts: "2.0" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threadContext: "" });
  });

  it("returns empty context when the thread read throws", async () => {
    mockGetThreadMessages.mockRejectedValue(new Error("network down"));
    const res = await post({ channel: "C1", threadTs: "1.0", ts: "2.0" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threadContext: "" });
  });
});
