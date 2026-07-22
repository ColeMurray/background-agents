import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type { SlackSessionTarget } from "../targets";
import { startSessionAndSendPrompt } from "./session-launcher";
import { getAvailableModels, getSlackDefaultModel } from "../app-home/models";
import { getUserRepoBranchPreference } from "../branch-preferences";
import { getResolvedUserPreferences } from "../user-preferences";
import { createSession } from "./control-plane-client";
import { deliverPrompt } from "./prompt-delivery";
import { buildThreadSession, storeThreadSession } from "./thread-session-store";
import { getUserInfo, postMessage } from "@open-inspect/shared";
import {
  notifyDroppedAttachments,
  prepareImageAttachments,
  type SlackImageAttachment,
} from "../attachments";

vi.mock("@open-inspect/shared", () => ({
  getUserInfo: vi.fn(),
  postMessage: vi.fn(),
}));

vi.mock("../attachments", () => ({
  prepareImageAttachments: vi.fn(async () => ({ files: [], dropped: [] })),
  notifyDroppedAttachments: vi.fn(async () => {}),
}));

vi.mock("./prompt-delivery", () => ({
  deliverPrompt: vi.fn(),
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
    vi.mocked(prepareImageAttachments).mockResolvedValue({ files: [], dropped: [] });
    vi.mocked(deliverPrompt).mockResolvedValue({ ok: true, data: { messageId: "message-1" } });
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
    expect(deliverPrompt).toHaveBeenCalledWith(env, {
      sessionId: "session-1",
      content:
        "Slack channel context:\n---\nChannel: #engineering\nDescription: Build and deploy discussion\n---\n\n" +
        "Context from the Slack thread:\n---\n[Alice]: Earlier request\n[Bot]: Earlier response\n---\n\n" +
        "Fix the failing deploy",
      authorId: "slack:U123",
      attachments: { files: [], dropped: [] },
      imageOnly: false,
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "111.222",
        repoFullName: "acme/app",
        model: "openai/gpt-5.4",
        reasoningEffort: "high",
      },
      channel: "C123",
      threadTs: "111.222",
      traceId: "trace-1",
    });
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
    expect(deliverPrompt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        content: "Inspect production",
        callbackContext: expect.objectContaining({ repoFullName: "Production Debug" }),
      })
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
    expect(deliverPrompt).not.toHaveBeenCalled();
    expect(storeThreadSession).not.toHaveBeenCalled();
  });

  it("notifies Slack and avoids storing thread state when prompt delivery fails", async () => {
    vi.mocked(deliverPrompt).mockResolvedValue({ ok: false, reason: "transient" });
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

  it("downloads message images before session creation and hands them to delivery", async () => {
    const images: SlackImageAttachment[] = [
      {
        id: "F1",
        name: "screenshot.png",
        mimetype: "image/png",
        downloadUrl: "https://files.slack.com/x",
      },
    ];
    const prepared = {
      files: [{ attachment: images[0]!, bytes: new Uint8Array(4) }],
      dropped: ["download_failed" as const],
    };
    vi.mocked(prepareImageAttachments).mockResolvedValue(prepared);
    const env = makeEnv();

    await expect(
      startSessionAndSendPrompt(env, {
        target: repositoryTarget,
        channel: "C123",
        threadTs: "111.222",
        messageText: "What is wrong in this screenshot?",
        userId: "U123",
        images,
        traceId: "trace-1",
      })
    ).resolves.toEqual({ sessionId: "session-1" });

    expect(prepareImageAttachments).toHaveBeenCalledWith(env, images, "trace-1");
    const prepareOrder = vi.mocked(prepareImageAttachments).mock.invocationCallOrder[0]!;
    const createOrder = vi.mocked(createSession).mock.invocationCallOrder[0]!;
    expect(prepareOrder).toBeLessThan(createOrder);
    expect(deliverPrompt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        sessionId: "session-1",
        content: expect.stringContaining("What is wrong in this screenshot?"),
        attachments: prepared,
        imageOnly: false,
      })
    );
  });

  it("never creates a session for an image-only request whose images were all lost", async () => {
    vi.mocked(prepareImageAttachments).mockResolvedValue({
      files: [],
      dropped: ["download_failed"],
    });
    const env = makeEnv();

    await expect(
      startSessionAndSendPrompt(env, {
        target: repositoryTarget,
        channel: "C123",
        threadTs: "111.222",
        messageText: "See the attached image(s).",
        userId: "U123",
        images: [
          {
            id: "F1",
            name: "screenshot.png",
            mimetype: "image/png",
            downloadUrl: "https://files.slack.com/x",
          },
        ],
        imageOnly: true,
      })
    ).resolves.toBeNull();

    expect(createSession).not.toHaveBeenCalled();
    expect(deliverPrompt).not.toHaveBeenCalled();
    expect(notifyDroppedAttachments).toHaveBeenCalledWith(
      env,
      "C123",
      "111.222",
      { references: [], dropped: ["download_failed"] },
      { traceId: undefined, nothingSent: true }
    );
  });

  it("posts no extra error when delivery already notified an image-only total loss", async () => {
    vi.mocked(deliverPrompt).mockResolvedValue({ ok: false, reason: "no_images_delivered" });
    vi.mocked(prepareImageAttachments).mockResolvedValue({
      files: [
        {
          attachment: {
            id: "F1",
            name: "screenshot.png",
            mimetype: "image/png",
            downloadUrl: "https://files.slack.com/x",
          },
          bytes: new Uint8Array(4),
        },
      ],
      dropped: [],
    });
    const env = makeEnv();

    await expect(
      startSessionAndSendPrompt(env, {
        target: repositoryTarget,
        channel: "C123",
        threadTs: "111.222",
        messageText: "See the attached image(s).",
        userId: "U123",
        images: [
          {
            id: "F1",
            name: "screenshot.png",
            mimetype: "image/png",
            downloadUrl: "https://files.slack.com/x",
          },
        ],
        imageOnly: true,
      })
    ).resolves.toBeNull();

    expect(postMessage).not.toHaveBeenCalled();
    expect(storeThreadSession).not.toHaveBeenCalled();
  });
});
