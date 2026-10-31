import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import type * as SlackModule from "@open-inspect/shared/slack";
import type { makeEnv } from "./test-helpers";
import {
  makeExecutionContext as makeCtx,
  makeSessionEnv,
  mockSlackFetch,
  promptFetchBodies,
  sessionFetchBodies,
  slackApiBodies,
  slackEventRequest,
  slackInteractionRequest,
  startingStatusBodies,
} from "./test-helpers";

const { mockVerifySlackSignature, mockGetUserInfo, mockMessagesCreate } = vi.hoisted(() => ({
  mockVerifySlackSignature: vi.fn(),
  mockGetUserInfo: vi.fn(),
  mockMessagesCreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockMessagesCreate } };
  }),
}));

vi.mock("@open-inspect/shared/slack", async () => {
  const actual = await vi.importActual<typeof SlackModule>("@open-inspect/shared/slack");
  return {
    ...actual,
    verifySlackSignature: mockVerifySlackSignature,
    getUserInfo: mockGetUserInfo,
  };
});

import app from "./index";
import { clearBotIdentityCache } from "./bot-identity";
import { RepoClassifier } from "./classifier";
import { clearEnvironmentsLocalCache } from "./classifier/environments";
import { clearLocalCache } from "./classifier/repos";

describe("solo threads: untagged follow-ups from the thread's only poster", () => {
  const OWNER = "U123";
  const THIRD = "U999";
  const ROOT_TS = "111.222";
  const SOLO_KEY = `solo-thread:C123:${ROOT_TS}`;
  const OWNED = { kind: "owned", ownerUserId: OWNER };
  const HINT = "You can reply without mentioning me while you are the only person in this thread.";
  const NOTICE =
    "This thread now has multiple people. From now on, mention <@UBOT> to send an instruction to this session.";
  const rootMessage = { ts: ROOT_TS, user: OWNER, text: "<@UBOT> fix the auth tests" };
  const botReply = { ts: "111.300", user: "UBOT", bot_id: "BSELF", text: "Working on it" };
  const ownerReply = { ts: "333.444", user: OWNER, text: "also cover the login page" };
  const thirdReply = { ts: "222.000", user: THIRD, text: "+1, seeing this too" };
  const session = {
    sessionId: "session-1",
    repoId: "acme/app",
    repoFullName: "acme/app",
    model: "anthropic/claude-haiku-4-5",
    createdAt: 1,
  };

  type SlackFetchOptions = Parameters<typeof mockSlackFetch>[1];
  type SessionResponses = Parameters<typeof makeSessionEnv>[1];
  type KvPut = Mock<(key: string, value: string) => Promise<void>>;
  let current: { env: ReturnType<typeof makeEnv>; slackFetch: ReturnType<typeof mockSlackFetch> };
  let consoleSpies: Array<MockInstance<typeof console.log>>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearBotIdentityCache();
    clearLocalCache();
    clearEnvironmentsLocalCache();
    mockVerifySlackSignature.mockResolvedValue(true);
    mockGetUserInfo.mockResolvedValue({ ok: false, error: "user_not_found" });
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_test",
          name: "classify_target",
          input: {
            targetId: "acme/app",
            confidence: "high",
            reasoning: "The request applies to the available repository.",
            alternatives: [],
          },
        },
      ],
    });
    consoleSpies = (["log", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );
  });

  afterEach(() => {
    const { env, slackFetch } = current;
    try {
      expectSoloThreadInvariant(env, slackFetch);
    } finally {
      slackFetch.mockRestore();
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  /** The structured log lines the bot wrote, parsed. */
  function logged(): Array<Record<string, unknown>> {
    return consoleSpies.flatMap((spy) =>
      spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    );
  }

  function soloReplyOutcomes() {
    return logged()
      .filter((line) => line.msg === "solo_thread.reply_decided")
      .map((line) => line.outcome);
  }

  function setup(slackOptions: SlackFetchOptions = {}, responses: SessionResponses = {}) {
    current = { env: makeSessionEnv([], responses), slackFetch: mockSlackFetch([], slackOptions) };
    return current;
  }

  function kvPut(env: ReturnType<typeof makeEnv>): KvPut {
    return (env.SLACK_KV as unknown as { put: KvPut }).put;
  }

  /** Make every solo-thread write fail, as when KV is unavailable. */
  function failSoloThreadStores(env: ReturnType<typeof makeEnv>) {
    const put = kvPut(env);
    const store = put.getMockImplementation()!;
    put.mockImplementation(async (key, value) => {
      if (key.startsWith("solo-thread:")) throw new Error("KV unavailable");
      await store(key, value);
    });
  }

  function solosPutAs(env: ReturnType<typeof makeEnv>, kind: string): number[] {
    const { calls, settledResults, invocationCallOrder } = kvPut(env).mock;
    return calls.flatMap(([key, value], i) =>
      key.startsWith("solo-thread:") &&
      JSON.parse(value).kind === kind &&
      settledResults[i]?.type === "fulfilled"
        ? [invocationCallOrder[i]]
        : []
    );
  }

  function slackCalls(
    slackFetch: ReturnType<typeof mockSlackFetch>,
    method: string,
    matches: (body: Record<string, unknown>) => boolean
  ): Array<{ order: number; body: Record<string, unknown> }> {
    const { calls, invocationCallOrder } = slackFetch.mock;
    return calls.flatMap(([input, init], i) => {
      if (!String(input).includes(method)) return [];
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return matches(body) ? [{ order: invocationCallOrder[i], body }] : [];
    });
  }

  const mentionsHint = (body: Record<string, unknown>) =>
    JSON.stringify([body.text, body.blocks]).includes(HINT);

  /**
   * Over every recorded KV write and Slack call: a thread is armed only when the
   * acknowledgement update that follows tells its owner, in its text and its
   * blocks, and the notice follows each stored block and nothing else.
   */
  function expectSoloThreadInvariant(
    env: ReturnType<typeof makeEnv>,
    slackFetch: ReturnType<typeof mockSlackFetch>
  ) {
    expect(slackCalls(slackFetch, "chat.postMessage", mentionsHint)).toEqual([]);
    const armed = solosPutAs(env, "owned");
    const hinted = slackCalls(slackFetch, "chat.update", mentionsHint);
    expect(hinted).toHaveLength(armed.length);
    hinted.forEach(({ order, body }, i) => {
      expect(order).toBeGreaterThan(armed[i]);
      expect(String(body.text)).toContain(`\n${HINT}`);
      expect(body.blocks).toContainEqual({
        type: "context",
        elements: [{ type: "mrkdwn", text: HINT }],
      });
    });
    const blocked = solosPutAs(env, "blocked");
    const notices = slackCalls(slackFetch, "chat.postMessage", (body) => body.text === NOTICE);
    expect(notices).toHaveLength(blocked.length);
    notices.forEach(({ order, body }, i) => {
      expect(order).toBeGreaterThan(blocked[i]);
      expect(body).toMatchObject({ channel: "C123", thread_ts: ROOT_TS });
    });
  }

  async function seedThread(
    env: ReturnType<typeof makeEnv>,
    solo: Record<string, unknown> | null = OWNED,
    sessionOverrides: Record<string, unknown> | null = {}
  ) {
    if (solo) await env.SLACK_KV.put(SOLO_KEY, JSON.stringify(solo));
    if (sessionOverrides) {
      await env.SLACK_KV.put(
        `thread:C123:${ROOT_TS}`,
        JSON.stringify({ ...session, ...sessionOverrides })
      );
    }
    kvPut(env).mockClear();
  }

  function threadReply(overrides: Record<string, unknown> = {}) {
    return {
      type: "message",
      channel: "C123",
      channel_type: "channel",
      user: OWNER,
      text: ownerReply.text,
      ts: ownerReply.ts,
      thread_ts: ROOT_TS,
      ...overrides,
    };
  }

  function mention(overrides: Record<string, unknown> = {}) {
    return {
      type: "app_mention",
      channel: "C123",
      user: OWNER,
      text: "<@UBOT> fix the auth tests",
      ts: ROOT_TS,
      ...overrides,
    };
  }

  async function flushAll(ctx: ReturnType<typeof makeCtx>) {
    for (let i = 0; i < ctx.waitUntil.mock.calls.length; i++) {
      await ctx.waitUntil.mock.calls[i][0];
    }
  }

  async function send(env: ReturnType<typeof makeEnv>, event: Record<string, unknown>) {
    const ctx = makeCtx();
    const response = await app.fetch(slackEventRequest(event), env, ctx);
    expect(response.status).toBe(200);
    await flushAll(ctx);
  }

  function threadReads(slackFetch: ReturnType<typeof mockSlackFetch>) {
    return slackFetch.mock.calls.filter(([input]) =>
      String(input).includes("conversations.replies")
    ).length;
  }

  async function soloRecord(env: ReturnType<typeof makeEnv>) {
    return env.SLACK_KV.get(SOLO_KEY, "json");
  }

  function launchedAcks(slackFetch: ReturnType<typeof mockSlackFetch>) {
    return slackApiBodies(slackFetch, "chat.update").map((body) => body.text);
  }

  /** handleChannelTrigger looks up watched channels once a message passes its own filters. */
  function automationLookups(env: ReturnType<typeof makeEnv>) {
    return env.CONTROL_PLANE.fetch.mock.calls.filter(([input]) =>
      String(input).includes("/watched-channels")
    );
  }

  describe("arming at launch", () => {
    it.each(["<@UBOT> fix the auth tests", "hey team, can <@UBOT> fix the auth tests?"])(
      "arms a top-level mention once the thread shows only its author: %j",
      async (text) => {
        const { env, slackFetch } = setup({ threadMessages: [{ ...rootMessage, text }, botReply] });
        await send(env, mention({ text }));
        expect(await soloRecord(env)).toEqual(OWNED);
        expect(threadReads(slackFetch)).toBe(1);
        expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([
          expect.objectContaining({ text: "Starting work..." }),
        ]);
        expect(launchedAcks(slackFetch)).toEqual([`Starting work...\n${HINT}`]);
      }
    );

    it("does not arm a top-level mention when another person replied before launch", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, thirdReply] });
      await send(env, mention());
      expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
      expect(await soloRecord(env)).toBeNull();
      expect(launchedAcks(slackFetch)).toEqual(["Starting work..."]);
    });

    it("arms a reply mention whose thread has only its owner, then takes an untagged reply", async () => {
      const { env } = setup({
        threadMessages: [
          { ts: ROOT_TS, user: OWNER, text: "the auth tests are flaky" },
          ownerReply,
        ],
      });
      await send(env, mention({ text: "<@UBOT> look into it", ts: "222.333", thread_ts: ROOT_TS }));
      expect(await soloRecord(env)).toEqual(OWNED);
      expect(launchedAcks(current.slackFetch)).toEqual([`Starting work...\n${HINT}`]);

      await send(env, threadReply());
      const prompts = promptFetchBodies(env.CONTROL_PLANE.fetch);
      expect(prompts).toHaveLength(2);
      expect(String(prompts[1].content)).toContain("[U123]: also cover the login page");
    });

    it.each([
      [
        "another person posted before the mention",
        {
          threadMessages: [
            { ts: ROOT_TS, user: THIRD, text: "anyone know why CI is red?" },
            { ts: "222.333", user: OWNER, text: "<@UBOT> look into it" },
          ],
        },
      ],
      ["the history cannot be read", { threadRepliesError: "ratelimited" }],
    ])("does not arm a reply mention when %s", async (_label, slackOptions) => {
      const { env, slackFetch } = setup(slackOptions);
      await send(env, mention({ text: "<@UBOT> look into it", ts: "222.333", thread_ts: ROOT_TS }));
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
      expect(await soloRecord(env)).toBeNull();
      expect(launchedAcks(slackFetch)).toEqual(["Starting work..."]);

      await send(env, threadReply());
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toHaveLength(1);
      expect(automationLookups(env)).toHaveLength(1);
    });

    it("does not arm a direct message", async () => {
      const { env, slackFetch } = setup({
        threadMessages: [{ ts: "444.555", user: OWNER, text: "fix the auth tests" }],
      });
      await send(env, {
        type: "message",
        text: "fix the auth tests",
        user: OWNER,
        channel: "D123",
        ts: "444.555",
        channel_type: "im",
      });
      expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
      expect(kvPut(env).mock.calls.filter(([key]) => key.startsWith("solo-thread:"))).toEqual([]);
      expect(threadReads(slackFetch)).toBe(0);
      expect(launchedAcks(slackFetch)).toEqual(["Starting work..."]);
    });

    it("shows no hint when the thread cannot be armed", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage] });
      failSoloThreadStores(env);
      await send(env, mention());
      expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
      expect(await soloRecord(env)).toBeNull();
      expect(launchedAcks(slackFetch)).toEqual(["Starting work..."]);
    });

    it("does not arm when the acknowledgement could not be posted", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage] });
      const respond = slackFetch.getMockImplementation()!;
      slackFetch.mockImplementation(async (input, init) =>
        String(input).includes("chat.postMessage")
          ? Response.json({ ok: false, error: "not_in_channel" })
          : respond(input, init)
      );
      await send(env, mention());
      expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
      expect(threadReads(slackFetch)).toBe(0);
      expect(await soloRecord(env)).toBeNull();
    });

    async function chooseTarget(env: ReturnType<typeof makeEnv>) {
      await env.SLACK_KV.put(
        `pending:C123:${ROOT_TS}`,
        JSON.stringify({ message: "fix the auth tests", userId: OWNER, messageTs: ROOT_TS })
      );
      const ctx = makeCtx();
      const response = await app.fetch(
        slackInteractionRequest({
          type: "block_actions",
          user: { id: OWNER },
          channel: { id: "C123" },
          message: { ts: "111.300", thread_ts: ROOT_TS },
          actions: [{ action_id: "select_repo", selected_option: { value: "acme/app" } }],
        }),
        env,
        ctx
      );
      expect(response.status).toBe(200);
      await flushAll(ctx);
    }

    it("arms after target clarification once the history shows only the owner", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, botReply] });
      await chooseTarget(env);
      expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
      expect(threadReads(slackFetch)).toBe(1);
      expect(await soloRecord(env)).toEqual(OWNED);
      expect(launchedAcks(slackFetch)).toEqual(["Using *acme/app*", `Starting work...\n${HINT}`]);
    });

    it("does not arm after target clarification once another person has replied", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, botReply, thirdReply] });
      await chooseTarget(env);
      expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
      expect(await soloRecord(env)).toBeNull();
      expect(launchedAcks(slackFetch)).toEqual(["Using *acme/app*", "Starting work..."]);
    });

    it("does not arm a mention that follows up on the thread's session", async () => {
      const { env } = setup({ threadMessages: [rootMessage, ownerReply] });
      await seedThread(env, null);
      await send(env, mention({ text: "<@UBOT> look into it", ts: "222.333", thread_ts: ROOT_TS }));
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
      expect(await soloRecord(env)).toBeNull();
    });
  });

  describe("ending a solo thread", () => {
    it("blocks the thread and says so when another person replies", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, thirdReply] });
      await seedThread(env);
      await send(env, threadReply({ user: THIRD, text: thirdReply.text, ts: thirdReply.ts }));
      expect(await soloRecord(env)).toEqual({ kind: "blocked" });
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([
        expect.objectContaining({ channel: "C123", thread_ts: ROOT_TS, text: NOTICE }),
      ]);
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(automationLookups(env)).toHaveLength(1);
    });

    it("blocks the thread and says so when another person's reply is also sent to the channel", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, thirdReply] });
      await seedThread(env);
      await send(
        env,
        threadReply({
          user: THIRD,
          subtype: "thread_broadcast",
          text: thirdReply.text,
          ts: thirdReply.ts,
        })
      );
      expect(await soloRecord(env)).toEqual({ kind: "blocked" });
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([
        expect.objectContaining({ channel: "C123", thread_ts: ROOT_TS, text: NOTICE }),
      ]);
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
    });

    it("keeps the thread blocked without another notice, even after they delete their reply", async () => {
      // The history no longer shows the other person: only the stored block remembers them.
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, ownerReply] });
      await seedThread(env);
      await send(env, threadReply({ user: THIRD, text: thirdReply.text, ts: thirdReply.ts }));
      await send(env, threadReply({ user: THIRD, text: "and on staging", ts: "222.100" }));
      await send(env, threadReply());
      expect(await soloRecord(env)).toEqual({ kind: "blocked" });
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toHaveLength(1);
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(threadReads(slackFetch)).toBe(0);
    });

    it("blocks the thread when another person mentions the bot, and still delivers their instruction", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, thirdReply] });
      await seedThread(env);
      const tagged = { user: THIRD, text: "<@UBOT> what about the API?", ts: "222.000" };
      await send(env, threadReply(tagged));
      await send(env, mention({ ...tagged, thread_ts: ROOT_TS }));
      expect(await soloRecord(env)).toEqual({ kind: "blocked" });
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([
        expect.objectContaining({ text: NOTICE }),
      ]);
    });

    it("blocks the thread and says so when its history shows a person whose event was missed", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, thirdReply, ownerReply] });
      await seedThread(env);
      await send(env, threadReply());
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(await soloRecord(env)).toEqual({ kind: "blocked" });
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([
        expect.objectContaining({ channel: "C123", thread_ts: ROOT_TS, text: NOTICE }),
      ]);
      expect(automationLookups(env)).toHaveLength(1);
    });

    it.each([
      ["another person replies", { user: THIRD, text: thirdReply.text, ts: thirdReply.ts }],
      ["the history shows another person", {}],
    ])("posts no notice when the block cannot be stored and %s", async (_label, overrides) => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, thirdReply, ownerReply] });
      await seedThread(env);
      failSoloThreadStores(env);
      await send(env, threadReply(overrides));
      expect(await soloRecord(env)).toEqual(OWNED);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([]);
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(automationLookups(env)).toHaveLength(1);
    });
  });

  describe("taking untagged replies", () => {
    it("takes the owner's untagged reply with no Slack integration settings (on by default)", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, botReply, ownerReply] });
      await seedThread(env);
      await send(env, threadReply());
      const prompts = promptFetchBodies(env.CONTROL_PLANE.fetch);
      expect(prompts).toHaveLength(1);
      expect(String(prompts[0].content)).toContain("[U123]: also cover the login page");
      expect(slackApiBodies(slackFetch, "reactions.add")).toEqual([
        expect.objectContaining({ channel: "C123", timestamp: ownerReply.ts, name: "eyes" }),
      ]);
      expect(startingStatusBodies(slackFetch)).not.toHaveLength(0);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([]);
      expect(soloReplyOutcomes()).toEqual(["taken"]);
    });

    it.each([
      ["no subtype", {}],
      ["file_share", { subtype: "file_share" }],
      ["a private channel", { channel_type: "group" }],
    ])("takes the owner's untagged reply with %s", async (_label, overrides) => {
      const { env } = setup({ threadMessages: [rootMessage, ownerReply] });
      await seedThread(env);
      await send(env, threadReply(overrides));
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
    });

    it("does not offer a taken reply to channel automations", async () => {
      const { env } = setup({ threadMessages: [rootMessage, ownerReply] });
      await seedThread(env);
      await send(env, threadReply());
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
      expect(automationLookups(env)).toEqual([]);
    });

    it("keeps the session model on a taken reply unless it sets !model", async () => {
      const { env } = setup({ threadMessages: [rootMessage, ownerReply] });
      await seedThread(env, OWNED, { model: "anthropic/claude-haiku-4-5", reasoningEffort: "max" });
      await send(env, threadReply());
      await send(env, threadReply({ text: "!reasoning high now add coverage", ts: "333.555" }));
      const [plain, overridden] = promptFetchBodies(env.CONTROL_PLANE.fetch);
      expect(plain.model).toBeUndefined();
      expect(plain.callbackContext).toMatchObject({
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "max",
      });
      expect(overridden).toMatchObject({
        reasoningEffort: "high",
        callbackContext: { model: "anthropic/claude-haiku-4-5", reasoningEffort: "high" },
      });
      expect(String(overridden.content)).not.toContain("!reasoning");
    });

    it("reports a malformed inline flag on a taken reply like a mentioned follow-up", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, ownerReply] });
      await seedThread(env);
      await send(env, threadReply({ text: "!model" }));
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([
        expect.objectContaining({ thread_ts: ROOT_TS, text: "The !model flag requires a value." }),
      ]);
    });

    it("reports a failed delivery on a taken reply like a mentioned follow-up", async () => {
      const { env, slackFetch } = setup(
        { threadMessages: [rootMessage, ownerReply] },
        { prompt: {} }
      );
      await seedThread(env);
      await send(env, threadReply());
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([
        expect.objectContaining({
          thread_ts: ROOT_TS,
          text: "Sorry, I couldn't send your follow-up. Please try again.",
        }),
      ]);
      expect(automationLookups(env)).toEqual([]);
    });

    it("does not read the files of a reply in a thread that was never armed", async () => {
      const { env } = setup({ threadMessages: [rootMessage, ownerReply] });
      await seedThread(env, null);
      const externalImage = {
        id: "F1",
        name: "screenshot.png",
        mimetype: "image/png",
        mode: "external",
        url_private: "https://example.com/screenshot.png",
      };
      await send(env, threadReply({ subtype: "file_share", files: [externalImage] }));
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(logged().map((line) => line.msg)).not.toContain("slack.attachment.untrusted_url");
      expect(soloReplyOutcomes()).toEqual([]);
    });

    it("ignores untagged replies in a thread that was never armed", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, ownerReply] });
      await seedThread(env, null);
      await send(env, threadReply());
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(threadReads(slackFetch)).toBe(0);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([]);
      expect(automationLookups(env)).toHaveLength(1);
      expect(await soloRecord(env)).toBeNull();
    });

    it("does not count other bots or Slackbot as people", async () => {
      const { env } = setup({
        threadMessages: [
          rootMessage,
          { ts: "200.000", bot_id: "BOTHER", text: "CI passed" },
          { ts: "200.100", user: "UOTHERBOT", bot_id: "BOTHER", text: "deploy done" },
          { ts: "200.200", user: "USLACKBOT", text: "reminder" },
          ownerReply,
        ],
      });
      await seedThread(env);
      await send(env, threadReply({ user: "USLACKBOT", text: "reminder", ts: "200.200" }));
      expect(await soloRecord(env)).toEqual(OWNED);
      await send(env, threadReply());
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
    });

    it.each([
      ["Slack returns an error", { threadRepliesError: "ratelimited" }],
      [
        "the thread is longer than the page cap",
        { threadMessages: [rootMessage, ownerReply], threadRepliesNextCursor: "more" },
      ],
      ["the history lacks the root", { threadMessages: [ownerReply] }],
    ])("drops the reply without blocking when %s", async (_label, slackOptions) => {
      const { env, slackFetch } = setup(slackOptions);
      await seedThread(env);
      await send(env, threadReply());
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([]);
      expect(await soloRecord(env)).toEqual(OWNED);
      expect(automationLookups(env)).toHaveLength(1);
      expect(soloReplyOutcomes()).toEqual(["history_incomplete"]);
    });

    it("never starts a session from an untagged reply, nor reads the thread for one", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, ownerReply] });
      const classify = vi.spyOn(RepoClassifier.prototype, "classify");
      await seedThread(env, OWNED, null);
      await send(env, threadReply());
      expect(threadReads(slackFetch)).toBe(0);
      expect(soloReplyOutcomes()).toEqual(["no_open_session"]);
      expect(classify).not.toHaveBeenCalled();
      expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([]);
      expect(automationLookups(env)).toHaveLength(1);
      classify.mockRestore();
    });

    it("stays silent on an untagged reply in a closed thread", async () => {
      const { env, slackFetch } = setup(
        { threadMessages: [rootMessage, ownerReply] },
        { publicationStatus: 404 }
      );
      await seedThread(env, OWNED, { closed: true });
      await send(env, threadReply());
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([]);
      expect(automationLookups(env)).toHaveLength(1);
    });

    it("stays silent on an untagged reply when the channel binding cannot be checked", async () => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, ownerReply] });
      const dispatch = env.CONTROL_PLANE.fetch.getMockImplementation()!;
      env.CONTROL_PLANE.fetch.mockImplementation(async (input, init) =>
        String(input).includes("/channel-bindings/")
          ? new Response(null, { status: 503 })
          : dispatch(input, init)
      );
      await seedThread(env);
      await send(env, threadReply());
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([]);
      expect(await env.SLACK_KV.get(`thread:C123:${ROOT_TS}`, "json")).toEqual(session);
    });

    it.each([
      ["only mentions a teammate", { text: "<@U555>" }],
      ["opens by addressing a teammate", { text: "<@U555|alice> can you check the staging logs?" }],
    ])("ignores an untagged reply that %s, without blocking", async (_label, overrides) => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, ownerReply] });
      await seedThread(env);
      await send(env, threadReply(overrides));
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([]);
      expect(await soloRecord(env)).toEqual(OWNED);
      expect(automationLookups(env)).toHaveLength(1);
    });

    it.each([
      ["message first", ["message", "app_mention"]],
      ["app_mention first", ["app_mention", "message"]],
    ])(
      "delivers a tagged owner reply once when Slack sends both events (%s)",
      async (_l, order) => {
        const { env } = setup({ threadMessages: [rootMessage, ownerReply] });
        await seedThread(env);
        for (const type of order) {
          await send(env, threadReply({ type, text: "hey <@UBOT> also cover the login page" }));
        }
        expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
        expect(await soloRecord(env)).toEqual(OWNED);
      }
    );

    it.each([
      ["an edit", { subtype: "message_changed" }],
      ["an also-send-to-channel reply", { subtype: "thread_broadcast" }],
      ["a top-level message", { thread_ts: undefined }],
      ["a thread root", { ts: ROOT_TS }],
      ["a group DM", { channel_type: "mpim" }],
    ])("does not take %s", async (_label, overrides) => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, ownerReply] });
      await seedThread(env);
      await send(env, threadReply(overrides));
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(threadReads(slackFetch)).toBe(0);
      expect(await soloRecord(env)).toEqual(OWNED);
    });

    it.each([
      [
        "only a file that is not an image",
        {
          subtype: "file_share",
          text: "",
          files: [
            {
              id: "F1",
              name: "notes.pdf",
              mimetype: "application/pdf",
              url_private: "https://files.slack.com/files-pri/T1-F1/notes.pdf",
            },
          ],
        },
      ],
      ["only flags", { text: "!reasoning high" }],
    ])("does not take a reply with %s, and posts nothing", async (_label, overrides) => {
      const { env, slackFetch } = setup({ threadMessages: [rootMessage, ownerReply] });
      await seedThread(env);
      await send(env, threadReply(overrides));
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([]);
      expect(threadReads(slackFetch)).toBe(0);
      expect(await soloRecord(env)).toEqual(OWNED);
    });

    it("ignores untagged replies when the bot user id is unknown", async () => {
      const { env, slackFetch } = setup();
      slackFetch.mockImplementation(async () =>
        Response.json({ ok: false, error: "invalid_auth" })
      );
      await seedThread(env);
      await send(env, threadReply());
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
    });
  });
});
