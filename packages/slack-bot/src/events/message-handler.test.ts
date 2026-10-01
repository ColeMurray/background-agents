import { beforeEach, describe, expect, it, vi } from "vitest";
import { postMessage } from "@open-inspect/shared/slack";
import { handleDirectMessage } from "./message-handler";
import { createClassifier, RepoClassifier } from "../classifier";
import { loadTargetCatalog } from "../classifier/catalog";
import { startSessionAndSendPrompt } from "../sessions/session-launcher";
import { deliverPrompt } from "../sessions/prompt-delivery";
import {
  closeThreadSession,
  lookupThreadSession,
  storeThreadSession,
} from "../sessions/thread-session-store";
import { storePendingRequest } from "../pending-requests/pending-request-store";
import type { Env } from "../types";

vi.mock(import("@open-inspect/shared/slack"), async (original) => ({
  ...(await original()),
  postMessage: vi.fn(async () => ({ ok: true as const, channel: "C1", ts: "3.000001" })),
  addReaction: vi.fn(async () => ({ ok: true as const })),
  updateMessage: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock(import("../classifier"), async (original) => ({
  ...(await original()),
  createClassifier: vi.fn(),
}));
vi.mock("../classifier/catalog", () => ({ loadTargetCatalog: vi.fn() }));
vi.mock("../sessions/session-launcher", () => ({
  startSessionAndSendPrompt: vi.fn(),
  loadAuthoritativeSlackLaunchSettings: vi.fn(),
}));
vi.mock("../sessions/prompt-delivery", () => ({ deliverPrompt: vi.fn() }));
vi.mock("../sessions/thread-session-store", () => ({
  THREAD_CLOSED_MESSAGE: "this session is no longer available from this channel",
  lookupThreadSession: vi.fn(),
  storeThreadSession: vi.fn(),
  closeThreadSession: vi.fn(),
  advanceLastPromptTs: vi.fn(),
}));
vi.mock("../pending-requests/pending-request-store", () => ({ storePendingRequest: vi.fn() }));
vi.mock(import("../messages/blocks"), async (original) => ({
  ...(await original()),
  scheduleStartingStatus: vi.fn(),
}));
vi.mock("../interactive-thread-context", () => ({ fetchInteractiveThreadContext: vi.fn() }));
vi.mock("../user-identity", () => ({
  resolveSlackActorIdentity: vi.fn(async () => ({ userId: "U1", senderLabel: "User (U1)" })),
}));

const mapping = {
  sessionId: "s1",
  repoId: "no-repository",
  repoFullName: "No repository",
  model: "openai/gpt-5.4",
  createdAt: 1,
  teamId: "team-a",
};
const event = { type: "message", text: "Fix it", user: "U1", channel: "C1", ts: "2.000001" };
const classify = vi.fn();

function makeEnv(response = Response.json({ teamId: "team-a", kind: "primary" })): Env {
  return {
    CONTROL_PLANE: { fetch: vi.fn(async () => response) },
    SERVICE_AUTH_SECRET: "test-secret",
    SLACK_BOT_TOKEN: "bot-token",
    LOG_LEVEL: "error",
  } as unknown as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lookupThreadSession).mockResolvedValue(null);
  const classifier = new RepoClassifier(makeEnv());
  classifier.classify = classify;
  vi.mocked(createClassifier).mockReturnValue(classifier);
  classify.mockResolvedValue({
    target: { kind: "none" },
    confidence: "high",
    source: "llm",
    needsClarification: false,
  });
  vi.mocked(startSessionAndSendPrompt).mockResolvedValue(null);
  vi.mocked(loadTargetCatalog).mockResolvedValue({ repos: [], environments: [] });
});

describe("channel-bound routing", () => {
  it.each([404, 503])("refuses a new request when binding lookup returns %s", async (status) => {
    const env = makeEnv(new Response(null, { status }));
    await handleDirectMessage(event, env, "trace", vi.fn());
    expect(classify).not.toHaveBeenCalled();
    expect(startSessionAndSendPrompt).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      "bot-token",
      "C1",
      expect.stringContaining(status === 404 ? "bind" : "verify"),
      { thread_ts: event.ts }
    );
    const [, init] = vi.mocked(env.CONTROL_PLANE.fetch).mock.calls[0];
    expect(init?.headers).toMatchObject({ "X-OpenInspect-Service": "slack-bot" });
  });

  it("fails closed on malformed bindings and network failures", async () => {
    for (const failure of [
      Response.json({ teamId: null, kind: "primary" }),
      new Error("offline"),
    ]) {
      const env = makeEnv();
      vi.mocked(env.CONTROL_PLANE.fetch).mockImplementation(async () => {
        if (failure instanceof Error) throw failure;
        return failure;
      });
      await handleDirectMessage(event, env, "trace", vi.fn());
    }
    expect(classify).not.toHaveBeenCalled();
    expect(startSessionAndSendPrompt).not.toHaveBeenCalled();
  });

  it.each(["team-a", null])(
    "passes binding scope %s to classification and launch",
    async (teamId) => {
      const env = makeEnv(Response.json(teamId ? { teamId, kind: "primary" } : { teamId: null }));
      await handleDirectMessage(event, env, "trace", vi.fn());
      expect(classify).toHaveBeenCalledWith("Fix it", expect.objectContaining({ teamId }), "trace");
      expect(startSessionAndSendPrompt).toHaveBeenCalledWith(
        env,
        expect.objectContaining({ teamId })
      );
    }
  );

  it("preserves the binding scope in clarification and catalog reads", async () => {
    classify.mockResolvedValue({
      target: null,
      confidence: "low",
      source: "llm",
      needsClarification: true,
      reasoning: "Pick one",
    });
    const env = makeEnv();
    await handleDirectMessage(event, env, "trace", vi.fn());
    expect(loadTargetCatalog).toHaveBeenCalledWith(env, "trace", "team-a");
    expect(storePendingRequest).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ teamId: "team-a" })
    );
  });
});

describe("closed follow-ups", () => {
  it("repeats a safe final message without prompting or classifying a closed mapping", async () => {
    vi.mocked(lookupThreadSession).mockResolvedValue({ ...mapping, closed: true });
    const env = makeEnv();
    await handleDirectMessage({ ...event, thread_ts: "1.000001" }, env, "trace", vi.fn());
    await handleDirectMessage({ ...event, text: "", thread_ts: "1.000001" }, env, "trace", vi.fn());
    expect(deliverPrompt).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledWith(
      "bot-token",
      "C1",
      "this session is no longer available from this channel",
      { thread_ts: "1.000001" }
    );
  });

  it("leaves a forbidden mapping open for other authorized users", async () => {
    vi.mocked(lookupThreadSession).mockResolvedValue(mapping);
    vi.mocked(deliverPrompt)
      .mockResolvedValueOnce({ ok: false, reason: "forbidden" })
      .mockResolvedValueOnce({ ok: true, data: { messageId: "authorized-prompt" } });
    const env = makeEnv();
    await handleDirectMessage({ ...event, thread_ts: "1.000001" }, env, "trace", vi.fn());
    await handleDirectMessage(
      { ...event, user: "U2", ts: "2.000002", thread_ts: "1.000001" },
      env,
      "trace",
      vi.fn()
    );
    expect(deliverPrompt).toHaveBeenCalledTimes(2);
    expect(deliverPrompt).toHaveBeenLastCalledWith(
      env,
      expect.objectContaining({ sessionId: "s1", authorId: "slack:U2" })
    );
    expect(closeThreadSession).not.toHaveBeenCalled();
    expect(storeThreadSession).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      "bot-token",
      "C1",
      "you do not have access to this session",
      { thread_ts: "1.000001" }
    );
    expect(classify).not.toHaveBeenCalled();
    expect(startSessionAndSendPrompt).not.toHaveBeenCalled();
  });

  it("closes a not-found mapping without reclassifying", async () => {
    vi.mocked(lookupThreadSession).mockResolvedValue(mapping);
    vi.mocked(deliverPrompt).mockResolvedValue({ ok: false, reason: "stale" });
    const env = makeEnv();
    await handleDirectMessage({ ...event, thread_ts: "1.000001" }, env, "trace", vi.fn());
    expect(closeThreadSession).toHaveBeenCalledWith(env, "C1", "1.000001", "s1");
    expect(postMessage).toHaveBeenCalledWith(
      "bot-token",
      "C1",
      "this session is no longer available from this channel",
      { thread_ts: "1.000001" }
    );
    expect(classify).not.toHaveBeenCalled();
    expect(startSessionAndSendPrompt).not.toHaveBeenCalled();
  });
});
