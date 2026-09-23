import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundRequestToSign } from "@open-inspect/shared/service-auth";
import { signedControlPlaneFetch } from "./internal-auth";
import { handleTask } from "./task";
import { createEnv, createInteraction, createKv } from "./test-helpers";

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

beforeEach(() => {
  vi.stubGlobal("fetch", discordFetch);
  cpFetch.mockImplementation(async (_env, request) => {
    if (request.url === "https://internal/repos") {
      return json({
        repos: [
          {
            id: 1,
            owner: "agustind",
            name: "andromeda-website",
            fullName: "agustind/andromeda-website",
            description: null,
            private: true,
            defaultBranch: "main",
            archived: false,
          },
        ],
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
      interaction: createInteraction(),
      prompt: "Make the icon black",
      repo: "Agustind/Andromeda-Website",
    });

    const [, create, prompt] = cpCalls();
    expect(create.actor).toBe("discord:user-1");
    expect(JSON.parse(create.body as string)).toMatchObject({
      repoOwner: "agustind",
      repoName: "andromeda-website",
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
        repoFullName: "agustind/andromeda-website",
        model: "anthropic/claude-opus-5",
      },
    });

    const [edit, thread] = discordCalls();
    expect(edit.url).toContain("/webhooks/app-1/interaction-token/messages/@original");
    expect(edit.body.content).toContain("https://web.example.com/session/s1");
    expect(thread.url).toContain("/channels/chan-tasks/messages/msg-1/threads");
    expect(JSON.parse(kv.store.get("thread:thread-1")!)).toMatchObject({ sessionId: "s1" });
    expect(discordCalls()[2].url).toContain("/channels/thread-1/messages");
    expect(kv.store.has("status:s1:thread-1")).toBe(true);
  });

  it("closes the status message when the prompt cannot be sent", async () => {
    const kv = createKv();
    const env = createEnv({ DISCORD_KV: kv as unknown as KVNamespace });
    const base = cpFetch.getMockImplementation()!;
    cpFetch.mockImplementation(async (e, request, init) =>
      request.url.endsWith("/prompt")
        ? new Response("nope", { status: 500 })
        : base(e, request, init)
    );

    await handleTask(env, {
      interaction: createInteraction(),
      prompt: "Make the icon black",
      repo: "agustind/andromeda-website",
    });

    expect(kv.store.has("status:s1:thread-1")).toBe(false);
    const edits = discordCalls().filter((call) => call.method === "PATCH");
    expect(edits.some((call) => String(call.body.content).startsWith("⚠️ **Stopped**"))).toBe(true);
  });

  it("sends a follow-up when run inside a task thread", async () => {
    const kv = createKv({
      "thread:thread-1": JSON.stringify({
        sessionId: "s1",
        repoFullName: "agustind/andromeda-website",
        model: "anthropic/claude-opus-5",
        createdAt: 1,
      }),
    });
    const env = createEnv({ DISCORD_KV: kv as unknown as KVNamespace });

    await handleTask(env, {
      interaction: createInteraction({ channel_id: "thread-1" }),
      prompt: "Also make it smaller",
      repo: undefined,
    });

    expect(cpCalls().map((call) => call.url)).toEqual(["https://internal/sessions/s1/prompt"]);
    const reply = discordCalls().find((call) => call.url.includes("/webhooks/"));
    expect(reply?.body.content).toContain("Follow-up");
    const status = discordCalls().find((call) => call.url.endsWith("/channels/thread-1/messages"));
    expect(status?.body.content).toContain("Working");
    expect(kv.store.has("status:s1:thread-1")).toBe(true);
  });

  it("rejects repositories the GitHub App cannot access", async () => {
    await handleTask(createEnv(), {
      interaction: createInteraction(),
      prompt: "Do something",
      repo: "someone/else",
    });

    expect(cpCalls().map((call) => call.url)).toEqual(["https://internal/repos"]);
    expect(discordCalls()[0].body.content).toContain("isn't a repository");
  });

  it("asks for a repository outside a task thread", async () => {
    await handleTask(createEnv(), {
      interaction: createInteraction(),
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
      interaction: createInteraction(),
      prompt: "Do something",
      repo: "agustind/andromeda-website",
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
      interaction: createInteraction(),
      prompt: "Make the icon black",
      repo: "agustind/andromeda-website",
    });

    const prompt = cpCalls().at(-1)!;
    const context = JSON.parse(prompt.body as string).callbackContext;
    expect(context.threadId).toBeUndefined();
    expect(context.channelId).toBe("chan-tasks");
  });
});
