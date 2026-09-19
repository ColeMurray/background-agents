import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessageDetails, postEphemeral, postMessage } from "@open-inspect/shared/slack";
import type { Env } from "../types";
import { handleTargetSelection } from "./target-selection";
import {
  getLegacyPendingRequest,
  getPendingRequest,
  deletePendingRequest,
  type PendingRequest,
} from "../pending-requests/pending-request-store";
import {
  loadAuthoritativeSlackLaunchSettings,
  startSessionAndSendPrompt,
} from "../sessions/session-launcher";
import { resolveTargetValue } from "../target-clarification";
import { resolveSlackActorIdentity } from "../user-identity";
import { fetchInteractiveThreadContext } from "../interactive-thread-context";

vi.mock(import("@open-inspect/shared/slack"), async (importOriginal) => ({
  ...(await importOriginal()),
  escapeMrkdwnText: (text: string) => text,
  getMessageDetails: vi.fn(),
  postEphemeral: vi.fn(async () => ({ ok: true as const, message_ts: "222.333" })),
  postMessage: vi.fn(async () => ({ ok: true as const, channel: "C123", ts: "222.333" })),
  updateMessage: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock("../messages/blocks", () => ({
  buildWorkingMessageBlocks: vi.fn(() => []),
  scheduleStartingStatus: vi.fn(),
}));

vi.mock("../pending-requests/pending-request-store", () => ({
  getPendingRequest: vi.fn(),
  deletePendingRequest: vi.fn(async () => {}),
  getLegacyPendingRequest: vi.fn(),
  deleteLegacyPendingRequest: vi.fn(async () => {}),
}));

vi.mock("../sessions/session-launcher", () => ({
  loadAuthoritativeSlackLaunchSettings: vi.fn(),
  startSessionAndSendPrompt: vi.fn(async () => ({ sessionId: "session-1" })),
}));

vi.mock("../target-clarification", () => ({
  resolveTargetValue: vi.fn(),
}));

vi.mock("../user-identity", () => ({
  resolveSlackActorIdentity: vi.fn(),
}));

vi.mock("../interactive-thread-context", () => ({
  fetchInteractiveThreadContext: vi.fn(),
}));

const DEFAULT_SELECTED_VALUE = "acme/app";
const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const TURN_PLAN = {
  sessionDefaults: {
    model: "anthropic/claude-sonnet-4-6" as const,
    reasoningEffort: "high" as const,
  },
  promptOverrides: {
    model: "openai/gpt-5.6-sol" as const,
    reasoningEffort: "high" as const,
  },
  effective: {
    model: "openai/gpt-5.6-sol" as const,
    reasoningEffort: "high" as const,
  },
};

function pendingRequest(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    requestId: REQUEST_ID,
    channel: "C123",
    threadTs: "111.222",
    message: "Fix the deploy",
    userId: "U123",
    ...overrides,
  };
}

const repositoryTarget = {
  kind: "repository" as const,
  repo: {
    id: DEFAULT_SELECTED_VALUE,
    owner: "acme",
    name: "app",
    fullName: DEFAULT_SELECTED_VALUE,
    displayName: DEFAULT_SELECTED_VALUE,
    description: "",
    defaultBranch: "main",
    private: true,
  },
};

function makeEnv(): Env {
  return {
    SLACK_BOT_TOKEN: "xoxb-test",
    WEB_APP_URL: "https://app.test",
    LOG_LEVEL: "error",
  } as Env;
}

function selectionRequest(selectedValue = DEFAULT_SELECTED_VALUE) {
  return {
    requestId: REQUEST_ID,
    selectedValue,
    channel: "C123",
    messageTs: "111.222",
    selectedBy: "U123",
    selectionSource: "picker" as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveTargetValue).mockResolvedValue(repositoryTarget);
  vi.mocked(resolveSlackActorIdentity).mockResolvedValue({
    userId: "U123",
    senderLabel: "Ajan (U123)",
    displayName: "Ajan",
  });
  vi.mocked(fetchInteractiveThreadContext).mockResolvedValue(undefined);
});

describe("handleTargetSelection", () => {
  it("re-fetches files and forwards the resolved turn plan unchanged", async () => {
    vi.mocked(getPendingRequest).mockResolvedValue(
      pendingRequest({
        message: "What is wrong in this screenshot?",
        unattributedPrompt: { forwardedMessages: ["Forwarded body"] },
        sourceMessage: { ts: "111.222" },
        turnPlan: TURN_PLAN,
      })
    );
    vi.mocked(getMessageDetails).mockResolvedValue({
      ok: true,
      files: [
        {
          id: "F1",
          name: "screenshot.png",
          mimetype: "image/png",
          url_private: "https://files.slack.com/files-pri/T1-F1/screenshot.png",
          size: 16,
        },
      ],
      attachments: [],
    });
    const env = makeEnv();

    await handleTargetSelection(selectionRequest(), env, "trace-1", vi.fn());

    expect(getMessageDetails).toHaveBeenCalledWith("xoxb-test", "C123", "111.222", undefined);
    expect(startSessionAndSendPrompt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        messageText:
          "Slack messages forwarded with this request:\n---\nForwarded body\n---\n\n" +
          "[Ajan (U123)]: What is wrong in this screenshot?",
        actor: {
          userId: "U123",
          senderLabel: "Ajan (U123)",
          displayName: "Ajan",
        },
        images: [
          {
            id: "F1",
            name: "screenshot.png",
            mimetype: "image/png",
            size: 16,
            downloadUrl: "https://files.slack.com/files-pri/T1-F1/screenshot.png",
          },
        ],
        turnPlan: TURN_PLAN,
      })
    );
    expect(deletePendingRequest).toHaveBeenCalledWith(env, REQUEST_ID);
  });

  it("launches without images when the pending request has no source message", async () => {
    vi.mocked(getPendingRequest).mockResolvedValue(pendingRequest());

    await handleTargetSelection(selectionRequest(), makeEnv(), "trace-1", vi.fn());

    expect(getMessageDetails).not.toHaveBeenCalled();
    expect(startSessionAndSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageText: "Fix the deploy", images: [] })
    );
  });

  it("re-fetches prior context images by coordinates and keeps the original checkpoint", async () => {
    const contextImage = {
      id: "F-prior",
      name: "prior.png",
      mimetype: "image/png",
      downloadUrl: "https://files.slack.com/prior.png",
    };
    vi.mocked(getPendingRequest).mockResolvedValue(
      pendingRequest({
        message: "Inspect the image above",
        messageTs: "111.000003",
        previousMessages: ["Earlier image annotation"],
        threadContextSource: { threadTs: "100.000001", beforeTs: "111.000003" },
      })
    );
    vi.mocked(fetchInteractiveThreadContext).mockResolvedValue({
      messages: ["Fresh annotation"],
      images: [contextImage],
    });
    const env = makeEnv();

    await handleTargetSelection(selectionRequest(), env, "trace-1", vi.fn());

    expect(fetchInteractiveThreadContext).toHaveBeenCalledWith(
      env,
      "C123",
      "100.000001",
      { beforeTs: "111.000003", includeBotMessages: true },
      "trace-1"
    );
    expect(startSessionAndSendPrompt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        messageTs: "111.000003",
        previousMessages: ["Earlier image annotation"],
        contextImages: [contextImage],
      })
    );
  });

  it("resolves overrides preserved in a legacy thread-keyed request", async () => {
    vi.mocked(getLegacyPendingRequest).mockResolvedValue({
      message: "Fix the deploy",
      userId: "U123",
      inlinePromptOptions: { model: "openai/gpt-5.6-sol", reasoningEffort: "high" },
    });
    const launchSettings = {
      enabledModels: ["openai/gpt-5.6-sol" as const],
      slackConfig: {},
      userPreferences: {
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "max",
        branch: undefined,
      },
    };
    vi.mocked(loadAuthoritativeSlackLaunchSettings).mockResolvedValue(launchSettings);

    await handleTargetSelection(
      { ...selectionRequest(), requestId: undefined },
      makeEnv(),
      "trace-1",
      vi.fn()
    );

    expect(startSessionAndSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        turnPlan: {
          sessionDefaults: {
            model: "anthropic/claude-sonnet-4-6",
            reasoningEffort: "max",
          },
          promptOverrides: {
            model: "openai/gpt-5.6-sol",
            reasoningEffort: "high",
          },
          effective: {
            model: "openai/gpt-5.6-sol",
            reasoningEffort: "high",
          },
        },
        launchSettings,
      })
    );
  });

  it("launches a selected no-repository target", async () => {
    vi.mocked(getPendingRequest).mockResolvedValue(
      pendingRequest({
        message: "Research this topic",
      })
    );
    vi.mocked(resolveTargetValue).mockResolvedValue({ kind: "none" });

    await handleTargetSelection(
      selectionRequest("__no_repository__"),
      makeEnv(),
      "trace-1",
      vi.fn()
    );

    expect(startSessionAndSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ target: { kind: "none" } })
    );
    expect(postMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C123",
      "Starting work...",
      expect.objectContaining({ thread_ts: "111.222" })
    );
  });

  it("still launches a text request when the file re-fetch fails", async () => {
    vi.mocked(getPendingRequest).mockResolvedValue(
      pendingRequest({
        message: "Fix what's in the screenshot",
        sourceMessage: { ts: "111.222", threadTs: "100.000" },
      })
    );
    vi.mocked(getMessageDetails).mockResolvedValue({ ok: false, error: "ratelimited" });

    await handleTargetSelection(selectionRequest(), makeEnv(), "trace-1", vi.fn());

    expect(getMessageDetails).toHaveBeenCalledWith("xoxb-test", "C123", "111.222", "100.000");
    expect(startSessionAndSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageText: "Fix what's in the screenshot", images: [] })
    );
  });

  it("aborts an image-only request when its images cannot be recovered", async () => {
    vi.mocked(getPendingRequest).mockResolvedValue(
      pendingRequest({
        message: "See the attached image(s).",
        imageOnly: true,
        sourceMessage: { ts: "111.222" },
      })
    );
    vi.mocked(getMessageDetails).mockResolvedValue({ ok: false, error: "message_not_found" });
    const env = makeEnv();

    await handleTargetSelection(selectionRequest(), env, "trace-1", vi.fn());

    expect(startSessionAndSendPrompt).not.toHaveBeenCalled();
    expect(vi.mocked(postMessage)).toHaveBeenCalledWith(
      "xoxb-test",
      "C123",
      expect.stringContaining("couldn't retrieve the attached image(s)"),
      { thread_ts: "111.222" }
    );
  });

  it("rejects a selection from someone other than the original requester", async () => {
    vi.mocked(getPendingRequest).mockResolvedValue(pendingRequest());

    await handleTargetSelection(
      { ...selectionRequest(), selectedBy: "U999" },
      makeEnv(),
      "trace-1",
      vi.fn()
    );

    expect(resolveTargetValue).not.toHaveBeenCalled();
    expect(startSessionAndSendPrompt).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledWith(
      "xoxb-test",
      "C123",
      "U999",
      "Only the person who made the original request can choose its target.",
      { thread_ts: "111.222" }
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("rejects a request whose stored channel or thread does not match the interaction", async () => {
    vi.mocked(getPendingRequest).mockResolvedValue(
      pendingRequest({ channel: "C999", threadTs: "999.000" })
    );

    await handleTargetSelection(selectionRequest(), makeEnv(), "trace-1", vi.fn());

    expect(resolveTargetValue).not.toHaveBeenCalled();
    expect(startSessionAndSendPrompt).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledWith(
      "xoxb-test",
      "C123",
      "U123",
      expect.stringContaining("no longer matches"),
      { thread_ts: "111.222" }
    );
  });

  it("launches the request bound to the clicked picker when another request shares its thread", async () => {
    const newerRequestId = "00000000-0000-4000-8000-000000000002";
    const pendingById = new Map([
      [REQUEST_ID, pendingRequest({ message: "Alice's original request" })],
      [
        newerRequestId,
        pendingRequest({
          requestId: newerRequestId,
          message: "Bob's newer request",
          userId: "U999",
        }),
      ],
    ]);
    vi.mocked(getPendingRequest).mockImplementation(
      async (_env, requestId) => pendingById.get(requestId) ?? null
    );

    await handleTargetSelection(selectionRequest(), makeEnv(), "trace-1", vi.fn());

    expect(getPendingRequest).toHaveBeenCalledWith(expect.anything(), REQUEST_ID);
    expect(startSessionAndSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageText: "Alice's original request" })
    );
  });
});
