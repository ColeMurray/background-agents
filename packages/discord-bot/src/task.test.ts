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

  it("rejects a harness Terraform would not have set", async () => {
    await handleTask(createEnv({ HARNESS: "cursor" }), {
      interaction: createGuildCommand(),
      prompt: "Do something",
      repo: "octo/website",
    });

    expect(cpCalls().map((call) => call.url)).toEqual(["https://internal/repos"]);
    expect(discordCalls()[0].body.content).toContain("Couldn't start the task");
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

  it("reports control-plane failures in the reply", async () => {
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

    expect(discordCalls()[0].body.content).toBe(
      "⚠️ Couldn't start the task: Could not create a session (403): assignment_required"
    );
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
