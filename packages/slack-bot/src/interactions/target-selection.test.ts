import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessageDetails, postMessage } from "@open-inspect/shared/slack";
import type { Env } from "../types";
import { handleTargetSelection } from "./target-selection";
import { getPendingRequest, deletePendingRequest } from "../pending-requests/pending-request-store";
import { startSessionAndSendPrompt } from "../sessions/session-launcher";
import { resolveTargetValue } from "../target-clarification";
import { resolveSlackActorIdentity } from "../user-identity";

vi.mock(import("@open-inspect/shared/slack"), async (importOriginal) => ({
  ...(await importOriginal()),
  escapeMrkdwnText: (text: string) => text,
  getMessageDetails: vi.fn(),
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
}));

vi.mock("../sessions/session-launcher", () => ({
  startSessionAndSendPrompt: vi.fn(async () => ({ sessionId: "session-1" })),
}));

vi.mock("../target-clarification", () => ({
  resolveTargetValue: vi.fn(),
}));

vi.mock("../user-identity", () => ({
  resolveSlackActorIdentity: vi.fn(),
}));

const repositoryTarget = {
  kind: "repository" as const,
  repo: {
    id: "acme/app",
    owner: "acme",
    name: "app",
    fullName: "acme/app",
    displayName: "acme/app",
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveTargetValue).mockResolvedValue(repositoryTarget);
  vi.mocked(resolveSlackActorIdentity).mockResolvedValue({
    userId: "U123",
    senderLabel: "Ajan (U123)",
    displayName: "Ajan",
  });
});

describe("handleTargetSelection", () => {
  it("re-fetches the source message's files and forwards them into the launch", async () => {
    vi.mocked(getPendingRequest).mockResolvedValue({
      message: "What is wrong in this screenshot?",
      userId: "U123",
      unattributedPrompt: { forwardedMessages: ["Forwarded body"] },
      sourceMessage: { ts: "111.222" },
    });
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

    await handleTargetSelection("acme/app", "C123", "111.222", undefined, env, "trace-1", vi.fn());

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
      })
    );
    expect(deletePendingRequest).toHaveBeenCalledWith(env, "C123", "111.222");
  });

  it("launches without images when the pending request has no source message", async () => {
    vi.mocked(getPendingRequest).mockResolvedValue({
      message: "Fix the deploy",
      userId: "U123",
    });

    await handleTargetSelection(
      "acme/app",
      "C123",
      "111.222",
      undefined,
      makeEnv(),
      "trace-1",
      vi.fn()
    );

    expect(getMessageDetails).not.toHaveBeenCalled();
    expect(startSessionAndSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageText: "Fix the deploy", images: [] })
    );
  });

  it("still launches a text request when the file re-fetch fails", async () => {
    vi.mocked(getPendingRequest).mockResolvedValue({
      message: "Fix what's in the screenshot",
      userId: "U123",
      sourceMessage: { ts: "111.222", threadTs: "100.000" },
    });
    vi.mocked(getMessageDetails).mockResolvedValue({ ok: false, error: "ratelimited" });

    await handleTargetSelection(
      "acme/app",
      "C123",
      "111.222",
      undefined,
      makeEnv(),
      "trace-1",
      vi.fn()
    );

    expect(getMessageDetails).toHaveBeenCalledWith("xoxb-test", "C123", "111.222", "100.000");
    expect(startSessionAndSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageText: "Fix what's in the screenshot", images: [] })
    );
  });

  it("aborts an image-only request when its images cannot be recovered", async () => {
    vi.mocked(getPendingRequest).mockResolvedValue({
      message: "See the attached image(s).",
      userId: "U123",
      imageOnly: true,
      sourceMessage: { ts: "111.222" },
    });
    vi.mocked(getMessageDetails).mockResolvedValue({ ok: false, error: "message_not_found" });
    const env = makeEnv();

    await handleTargetSelection("acme/app", "C123", "111.222", undefined, env, "trace-1", vi.fn());

    expect(startSessionAndSendPrompt).not.toHaveBeenCalled();
    expect(vi.mocked(postMessage)).toHaveBeenCalledWith(
      "xoxb-test",
      "C123",
      expect.stringContaining("couldn't retrieve the attached image(s)"),
      { thread_ts: "111.222" }
    );
  });
});
