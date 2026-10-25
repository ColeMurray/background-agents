import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundRequestToSign } from "@open-inspect/shared/service-auth";
import { signedControlPlaneFetch } from "./internal-auth";
import { handleTask } from "./task";
import { createEnv, createGuildCommand, createKv } from "./test-helpers";

vi.mock("./internal-auth", () => ({ signedControlPlaneFetch: vi.fn() }));

const cpFetch = vi.mocked(signedControlPlaneFetch);
const discordFetch = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function cpCalls(): OutboundRequestToSign[] {
  return cpFetch.mock.calls.map(([, request]) => request);
}

function discordCalls(): { url: string; method: string; body: Record<string, unknown> }[] {
  return discordFetch.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: init.method,
    body: init.body ? JSON.parse(init.body) : {},
  }));
}

function repo(owner: string, name: string) {
  return {
    id: 1,
    owner,
    name,
    fullName: `${owner}/${name}`,
    description: null,
    private: true,
    defaultBranch: "main",
    archived: false,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", discordFetch);
  cpFetch.mockImplementation(async (_env, request) => {
    if (request.url === "https://internal/repos") {
      return json({
        repos: [repo("octo", "website"), repo("group/subgroup", "api")],
        cached: false,
        cachedAt: "2026-09-23T00:00:00Z",
      });
    }
    if (request.url === "https://internal/sessions")
      return json({ sessionId: "s1", status: "created" });
    return json({ messageId: "m1" });
  });
  discordFetch.mockImplementation(async (url: string) =>
    String(url).includes("/threads") ? json({ id: "thread-1" }) : json({ id: "msg-1" })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("handleTask", () => {
  it("creates a Claude Agent session, opens a thread, and sends the prompt", async () => {
    const kv = createKv();
    const env = createEnv({ DISCORD_KV: kv as unknown as KVNamespace });

    await handleTask(env, {
      interaction: createGuildCommand(),
      prompt: "Make the icon black",
      repo: "Octo/Website",
    });

    const [, create, prompt] = cpCalls();
    expect(create.actor).toBe("discord:user-1");
    expect(JSON.parse(create.body as string)).toMatchObject({
      repoOwner: "octo",
      repoName: "website",
      harness: "claude",
      model: "anthropic/claude-opus-5",
      actorDisplayName: "Agu",
    });
    expect(prompt.url).toBe("https://internal/sessions/s1/prompt");
    expect(JSON.parse(prompt.body as string)).toEqual({
      content: "Make the icon black",
      source: "discord",
      callbackContext: {
        source: "discord",
        channelId: "chan-tasks",
        threadId: "thread-1",
        userId: "user-1",
        repoFullName: "octo/website",
        model: "anthropic/claude-opus-5",
        statusMessage: { id: "msg-1", startedAt: expect.any(Number) },
      },
    });

    const [edit, thread, status] = discordCalls();
    expect(edit.url).toContain("/webhooks/app-1/interaction-token/messages/@original");
    expect(edit.body.content).toContain("https://web.example.com/session/s1");
    expect(thread.url).toContain("/channels/chan-tasks/messages/msg-1/threads");
    expect(status.url).toContain("/channels/thread-1/messages");
    expect(JSON.parse(kv.store.get("thread:thread-1")!)).toMatchObject({ sessionId: "s1" });
  });

  it("keeps a nested owner intact when creating the session", async () => {
    await handleTask(createEnv(), {
      interaction: createGuildCommand(),
      prompt: "Do something",
      repo: "group/subgroup/api",
    });

    const [, create] = cpCalls();
    expect(JSON.parse(create.body as string)).toMatchObject({
      repoOwner: "group/subgroup",
      repoName: "api",
    });
  });

  it("reports actionable launch configuration errors without silently defaulting", async () => {
    await handleTask(createEnv({ HARNESS: "cursor" }), {
      interaction: createGuildCommand(),
      prompt: "Do something",
      repo: "octo/website",
    });

    expect(cpCalls().map((call) => call.url)).toEqual(["https://internal/repos"]);
    expect(discordCalls()[0].body.content).toContain("Set HARNESS to claude or opencode");
  });

  it("closes the status message when the prompt cannot be sent", async () => {
    const base = cpFetch.getMockImplementation()!;
    cpFetch.mockImplementation(async (e, request, init) =>
      request.url.endsWith("/prompt")
        ? new Response("nope", { status: 500 })
        : base(e, request, init)
    );

    await handleTask(createEnv(), {
      interaction: createGuildCommand(),
      prompt: "Make the icon black",
      repo: "octo/website",
    });

    const edits = discordCalls().filter((call) => call.method === "PATCH");
    expect(edits.some((call) => String(call.body.content).startsWith("⚠️ **Stopped**"))).toBe(true);
    expect(edits.at(-1)!.body.content).toContain("Couldn't start the task");
  });

  it("sends a follow-up when run inside a task thread", async () => {
    const kv = createKv({
      "thread:thread-1": JSON.stringify({
        sessionId: "s1",
        repoFullName: "octo/website",
        model: "anthropic/claude-opus-5",
        createdAt: 1,
      }),
    });
    const env = createEnv({ DISCORD_KV: kv as unknown as KVNamespace });

    await handleTask(env, {
      interaction: createGuildCommand({ channel_id: "thread-1" }),
      prompt: "Also make it smaller",
      repo: undefined,
    });

    expect(cpCalls().map((call) => call.url)).toEqual(["https://internal/sessions/s1/prompt"]);
    const reply = discordCalls().find((call) => call.url.includes("/webhooks/"));
    expect(reply?.body.content).toContain("Follow-up");
    const status = discordCalls().find((call) => call.url.endsWith("/channels/thread-1/messages"));
    expect(status?.body.content).toContain("Working");
    const context = JSON.parse(cpCalls()[0].body as string).callbackContext;
    expect(context).toMatchObject({
      threadId: "thread-1",
      statusMessage: { id: "msg-1" },
    });
  });

  it("rejects a different repository inside a task thread", async () => {
    const kv = createKv({
      "thread:thread-1": JSON.stringify({
        sessionId: "s1",
        repoFullName: "octo/website",
        model: "anthropic/claude-opus-5",
        createdAt: 1,
      }),
    });

    await handleTask(createEnv({ DISCORD_KV: kv as unknown as KVNamespace }), {
      interaction: createGuildCommand({ channel_id: "thread-1" }),
      prompt: "Fix the API instead",
      repo: "acme/api",
    });

    expect(cpCalls()).toHaveLength(0);
    expect(discordCalls()[0].body.content).toContain("This thread works on `octo/website`");
  });

  it("rejects repositories the GitHub App cannot access", async () => {
    await handleTask(createEnv(), {
      interaction: createGuildCommand(),
      prompt: "Do something",
      repo: "someone/else",
    });

    expect(cpCalls().map((call) => call.url)).toEqual(["https://internal/repos"]);
    expect(discordCalls()[0].body.content).toContain("isn't a repository");
  });

  it("asks for a repository outside a task thread", async () => {
    await handleTask(createEnv(), {
      interaction: createGuildCommand(),
      prompt: "Do something",
      repo: undefined,
    });

    expect(cpCalls()).toEqual([]);
    expect(discordCalls()[0].body.content).toContain("Pick a repository");
  });

  it("reports control-plane failures without leaking their details", async () => {
    const repos = cpFetch.getMockImplementation()!;
    cpFetch.mockImplementation(async (env, request, init) =>
      request.url === "https://internal/sessions"
        ? new Response("assignment_required", { status: 403 })
        : repos(env, request, init)
    );

    await handleTask(createEnv(), {
      interaction: createGuildCommand(),
      prompt: "Do something",
      repo: "octo/website",
    });

    const content = discordCalls()[0].body.content;
    expect(content).toMatch(/^⚠️ Couldn't start the task\. Trace ID: `[0-9a-f-]{36}`$/);
    expect(content).not.toContain("assignment_required");
  });

  it("maps team_required to an actionable static message without exposing API text", async () => {
    const base = cpFetch.getMockImplementation()!;
    const rejected = json({ code: "team_required", error: "private database detail" }, 400);
    const parse = vi.spyOn(rejected, "json");
    cpFetch.mockImplementation(async (env, request, init) =>
      request.url === "https://internal/sessions" ? rejected : base(env, request, init)
    );
    await handleTask(createEnv(), {
      interaction: createGuildCommand(),
      prompt: "Fix it",
      repo: "octo/website",
    });
    expect(parse).toHaveBeenCalledOnce();
    const content = discordCalls()[0].body.content;
    expect(content).toContain("requires a team");
    expect(content).toContain("web app");
    expect(content).not.toContain("private database detail");
    expect(cpCalls().some((call) => call.url.endsWith("/prompt"))).toBe(false);
  });

  it.each([
    "not JSON",
    JSON.stringify({ code: "other", error: "private detail" }),
    JSON.stringify(["team_required"]),
  ])("keeps unexpected or malformed 400 refusals private: %s", async (body) => {
    const base = cpFetch.getMockImplementation()!;
    cpFetch.mockImplementation(async (env, request, init) =>
      request.url === "https://internal/sessions"
        ? new Response(body, { status: 400 })
        : base(env, request, init)
    );
    await handleTask(createEnv(), {
      interaction: createGuildCommand(),
      prompt: "Fix it",
      repo: "octo/website",
    });
    expect(discordCalls()[0].body.content).toMatch(/^⚠️ Couldn't start the task\. Trace ID:/);
    expect(discordCalls()[0].body.content).not.toContain(body);
  });

  it("does not create another session when thread lookup fails", async () => {
    const kv = createKv();
    kv.get.mockRejectedValueOnce(new Error("KV unavailable"));
    await handleTask(createEnv({ DISCORD_KV: kv as unknown as KVNamespace }), {
      interaction: createGuildCommand({ channel_id: "thread-1" }),
      prompt: "Follow up",
      repo: "octo/website",
    });
    expect(cpFetch).not.toHaveBeenCalled();
    expect(discordCalls()[0].body.content).toContain("Couldn't start the task");
  });

  it("still sends to the created thread when storing its mapping fails", async () => {
    const kv = createKv();
    kv.put.mockImplementation(async (key, value) => {
      if (key.startsWith("thread:")) throw new Error("KV write failed");
      kv.store.set(key, value);
    });
    await handleTask(createEnv({ DISCORD_KV: kv as unknown as KVNamespace }), {
      interaction: createGuildCommand(),
      prompt: "Fix it",
      repo: "octo/website",
    });
    expect(JSON.parse(cpCalls().at(-1)!.body as string).callbackContext.threadId).toBe("thread-1");
  });

  it("still sends the prompt when the thread cannot be created", async () => {
    discordFetch.mockImplementation(async (url: string) =>
      String(url).includes("/threads")
        ? json({ message: "Missing Permissions" }, 403)
        : json({ id: "msg-1" })
    );

    await handleTask(createEnv(), {
      interaction: createGuildCommand(),
      prompt: "Make the icon black",
      repo: "octo/website",
    });

    const prompt = cpCalls().at(-1)!;
    const context = JSON.parse(prompt.body as string).callbackContext;
    expect(context.threadId).toBeUndefined();
    expect(context.channelId).toBe("chan-tasks");
  });

  it("sends the prompt without progress when the status message cannot be posted", async () => {
    discordFetch.mockImplementation(async (url: string, init: RequestInit) =>
      String(url).endsWith("/channels/thread-1/messages") && init.method === "POST"
        ? json({ message: "Missing Permissions" }, 403)
        : json({ id: String(url).includes("/threads") ? "thread-1" : "msg-1" })
    );

    await handleTask(createEnv(), {
      interaction: createGuildCommand(),
      prompt: "Make the icon black",
      repo: "octo/website",
    });

    const context = JSON.parse(cpCalls().at(-1)!.body as string).callbackContext;
    expect(context.statusMessage).toBeUndefined();
  });
});
