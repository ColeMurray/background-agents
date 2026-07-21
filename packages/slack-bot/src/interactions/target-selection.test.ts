import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { handleTargetSelection } from "./target-selection";
import { getPendingRequest, deletePendingRequest } from "../pending-requests/pending-request-store";
import { startSessionAndSendPrompt } from "../sessions/session-launcher";
import { resolveTargetValue } from "../target-clarification";

vi.mock("@open-inspect/shared", () => ({
  escapeMrkdwnText: (text: string) => text,
  postMessage: vi.fn(async () => ({ ok: true, channel: "C123", ts: "222.333" })),
  updateMessage: vi.fn(async () => ({ ok: true })),
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
});

describe("handleTargetSelection", () => {
  it("replays pending-request files into the launched session", async () => {
    const files = [
      {
        id: "F1",
        name: "screenshot.png",
        mimetype: "image/png",
        url_private: "https://files.slack.com/files-pri/T1-F1/screenshot.png",
        size: 16,
      },
    ];
    vi.mocked(getPendingRequest).mockResolvedValue({
      message: "What is wrong in this screenshot?",
      userId: "U123",
      files,
    });
    const env = makeEnv();

    await handleTargetSelection("acme/app", "C123", "111.222", undefined, env, "trace-1", vi.fn());

    expect(startSessionAndSendPrompt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        messageText: "What is wrong in this screenshot?",
        userId: "U123",
        files,
      })
    );
    expect(deletePendingRequest).toHaveBeenCalledWith(env, "C123", "111.222");
  });

  it("launches without files when the pending request has none", async () => {
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

    expect(startSessionAndSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageText: "Fix the deploy", files: undefined })
    );
  });
});
