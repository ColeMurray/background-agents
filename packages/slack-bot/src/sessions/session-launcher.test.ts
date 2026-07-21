import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type { SlackSessionTarget } from "../targets";
import { startSessionAndSendPrompt } from "./session-launcher";
import { getAvailableModels, getSlackDefaultModel } from "../app-home/models";
import { getUserRepoBranchPreference } from "../branch-preferences";
import { getResolvedUserPreferences } from "../user-preferences";
import { createSession, sendPrompt } from "./control-plane-client";
import { buildThreadSession, storeThreadSession } from "./thread-session-store";
import { getUserInfo, postMessage } from "@open-inspect/shared";
import { notifyDroppedAttachments, uploadSlackImageAttachments } from "../attachments";

vi.mock("@open-inspect/shared", () => ({
  getUserInfo: vi.fn(),
  postMessage: vi.fn(),
}));

vi.mock("../attachments", () => ({
  uploadSlackImageAttachments: vi.fn(async () => ({ references: [], dropped: [] })),
  notifyDroppedAttachments: vi.fn(async () => {}),
}));

vi.mock("../app-home/models", () => ({
  getAvailableModels: vi.fn(),
  getSlackDefaultModel: vi.fn(),
}));

vi.mock("../branch-preferences", () => ({
  getUserRepoBranchPreference: vi.fn(),
}));

vi.mock("../user-preferences", () => ({
  getResolvedUserPreferences: vi.fn(),
}));

vi.mock("./control-plane-client", () => ({
  createSession: vi.fn(),
  sendPrompt: vi.fn(),
}));

vi.mock("./thread-session-store", () => ({
  buildThreadSession: vi.fn(),
  storeThreadSession: vi.fn(),
}));

function makeEnv(): Env {
  return {
    SLACK_BOT_TOKEN: "xoxb-test",
    DEFAULT_MODEL: "openai/gpt-5.4",
    WEB_APP_URL: "https://app.example.com",
    LOG_LEVEL: "error",
  } as Env;
}

const repositoryTarget: SlackSessionTarget = {
  kind: "repository",
  repo: {
    id: "acme/app",
    owner: "acme",
    name: "app",
    fullName: "acme/app",
    displayName: "acme/app",
    description: "Application repository",
    defaultBranch: "main",
    private: true,
  },
};

const environmentTarget: SlackSessionTarget = {
  kind: "environment",
  environment: {
    id: "env_123",
    name: "Production Debug",
    description: "Production debugging environment",
    prebuildEnabled: true,
    repositories: [
      {
        repoOwner: "acme",
        repoName: "infra",
        repoId: 123,
        baseBranch: "release",
      },
    ],
    createdAt: 1,
    updatedAt: 2,
  },
};

describe("startSessionAndSendPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAvailableModels).mockResolvedValue([
      { label: "GPT 5.4", value: "openai/gpt-5.4" },
      { label: "Claude Sonnet", value: "anthropic/claude-sonnet-4-6" },
    ]);
    vi.mocked(getSlackDefaultModel).mockResolvedValue("anthropic/claude-sonnet-4-6");
    vi.mocked(getResolvedUserPreferences).mockResolvedValue({
      model: "openai/gpt-5.4",
      reasoningEffort: "high",
      branch: "user-default-branch",
    });
    vi.mocked(getUserRepoBranchPreference).mockResolvedValue("repo-override-branch");
    vi.mocked(getUserInfo).mockResolvedValue({
      ok: true,
      user: {
        id: "U123",
        name: "fallback-name",
        real_name: "Real Name",
        profile: { display_name: "Display Name", email: "user@example.com" },
      },
    } as Awaited<ReturnType<typeof getUserInfo>>);
    vi.mocked(createSession).mockResolvedValue({ sessionId: "session-1", status: "created" });
    vi.mocked(sendPrompt).mockResolvedValue({ ok: true, data: { messageId: "message-1" } });
    vi.mocked(buildThreadSession).mockReturnValue({
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      reasoningEffort: "high",
      createdAt: 123,
    });
    vi.mocked(postMessage).mockResolvedValue({ ok: true, channel: "C123", ts: "111.333" });
  });

  it("creates a repository session with resolved preferences and sends contextualized prompt", async () => {
    const env = makeEnv();

    await expect(
      startSessionAndSendPrompt(env, {
        target: repositoryTarget,
        channel: "C123",
        threadTs: "111.222",
        messageText: "Fix the failing deploy",
        userId: "U123",
        previousMessages: ["[Alice]: Earlier request", "[Bot]: Earlier response"],
        channelName: "engineering",
        channelDescription: "Build and deploy discussion",
        traceId: "trace-1",
      })
    ).resolves.toEqual({ sessionId: "session-1" });

    expect(getResolvedUserPreferences).toHaveBeenCalledWith(env, "U123", {
      defaultModel: "anthropic/claude-sonnet-4-6",
      enabledModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
    });
    expect(getUserRepoBranchPreference).toHaveBeenCalledWith(env, "U123", "acme/app");
    expect(createSession).toHaveBeenCalledWith(env, {
      target: repositoryTarget,
      model: "openai/gpt-5.4",
      reasoningEffort: "high",
      branch: "repo-override-branch",
      traceId: "trace-1",
      slackUserId: "U123",
      actorDisplayName: "Display Name",
      actorEmail: "user@example.com",
    });
    expect(sendPrompt).toHaveBeenCalledWith(
      env,
      "session-1",
      "Slack channel context:\n---\nChannel: #engineering\nDescription: Build and deploy discussion\n---\n\n" +
        "Context from the Slack thread:\n---\n[Alice]: Earlier request\n[Bot]: Earlier response\n---\n\n" +
        "Fix the failing deploy",
      "slack:U123",
      {
        source: "slack",
        channel: "C123",
        threadTs: "111.222",
        repoFullName: "acme/app",
        model: "openai/gpt-5.4",
        reasoningEffort: "high",
      },
      "trace-1",
      []
    );
    expect(buildThreadSession).toHaveBeenCalledWith(
      "session-1",
      repositoryTarget,
      "openai/gpt-5.4",
      "high",
      undefined
    );
    expect(storeThreadSession).toHaveBeenCalledWith(env, "C123", "111.222", {
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      reasoningEffort: "high",
      createdAt: 123,
    });
  });

  it("does not apply repository branch overrides to environment sessions", async () => {
    const env = makeEnv();

    await startSessionAndSendPrompt(env, {
      target: environmentTarget,
      channel: "C123",
      threadTs: "111.222",
      messageText: "Inspect production",
      userId: "U123",
    });

    expect(getUserRepoBranchPreference).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ target: environmentTarget, branch: undefined })
    );
    expect(sendPrompt).toHaveBeenCalledWith(
      env,
      "session-1",
      "Inspect production",
      "slack:U123",
      expect.objectContaining({ repoFullName: "Production Debug" }),
      undefined,
      []
    );
  });

  it("notifies Slack and skips prompt delivery when session creation fails", async () => {
    vi.mocked(createSession).mockResolvedValue(null);
    const env = makeEnv();

    await expect(
      startSessionAndSendPrompt(env, {
        target: repositoryTarget,
        channel: "C123",
        threadTs: "111.222",
        messageText: "Fix it",
        userId: "U123",
      })
    ).resolves.toBeNull();

    expect(postMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C123",
      "Sorry, I couldn't create a session. Please try again.",
      { thread_ts: "111.222" }
    );
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(storeThreadSession).not.toHaveBeenCalled();
  });

  it("notifies Slack and avoids storing thread state when prompt delivery fails", async () => {
    vi.mocked(sendPrompt).mockResolvedValue({ ok: false, reason: "transient" });
    const env = makeEnv();

    await expect(
      startSessionAndSendPrompt(env, {
        target: repositoryTarget,
        channel: "C123",
        threadTs: "111.222",
        messageText: "Fix it",
        userId: "U123",
      })
    ).resolves.toBeNull();

    expect(postMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C123",
      "Session created but failed to send prompt. Please try again.",
      { thread_ts: "111.222" }
    );
    expect(storeThreadSession).not.toHaveBeenCalled();
  });

  it("uploads message images to the new session and passes references with the prompt", async () => {
    vi.mocked(uploadSlackImageAttachments).mockResolvedValue({
      references: [{ attachmentId: "att-1", name: "screenshot.png" }],
      dropped: ["download_failed"],
    });
    const env = makeEnv();
    const files = [{ id: "F1", mimetype: "image/png", url_private: "https://files/x" }];

    await expect(
      startSessionAndSendPrompt(env, {
        target: repositoryTarget,
        channel: "C123",
        threadTs: "111.222",
        messageText: "What is wrong in this screenshot?",
        userId: "U123",
        files,
        traceId: "trace-1",
      })
    ).resolves.toEqual({ sessionId: "session-1" });

    expect(uploadSlackImageAttachments).toHaveBeenCalledWith(env, "session-1", files, "trace-1");
    expect(notifyDroppedAttachments).toHaveBeenCalledWith(
      env,
      "C123",
      "111.222",
      {
        references: [{ attachmentId: "att-1", name: "screenshot.png" }],
        dropped: ["download_failed"],
      },
      "trace-1"
    );
    expect(sendPrompt).toHaveBeenCalledWith(
      env,
      "session-1",
      expect.stringContaining("What is wrong in this screenshot?"),
      "slack:U123",
      expect.anything(),
      "trace-1",
      [{ attachmentId: "att-1", name: "screenshot.png" }]
    );
  });
});
