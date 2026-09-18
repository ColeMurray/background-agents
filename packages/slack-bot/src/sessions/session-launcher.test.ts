import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type { SlackSessionTarget } from "../targets";
import type { SlackActorIdentity } from "../user-identity";
import { startSessionAndSendPrompt } from "./session-launcher";
import { getAvailableModels } from "../app-home/models";
import { getUserRepoBranchPreference } from "../branch-preferences";
import { getResolvedUserPreferences } from "../user-preferences";
import { createSession } from "./control-plane-client";
import { getSlackSettings } from "../slack-settings";
import { deliverPrompt } from "./prompt-delivery";
import { buildThreadSession, storeThreadSession } from "./thread-session-store";
import { postMessage } from "@open-inspect/shared/slack";
import {
  notifyDroppedAttachments,
  preparePromptImageAttachments,
  type SlackImageAttachment,
} from "../attachments";

vi.mock("@open-inspect/shared/slack", () => ({
  postMessage: vi.fn(),
}));

vi.mock("../attachments", () => ({
  preparePromptImageAttachments: vi.fn(async () => ({ files: [], dropped: [] })),
  notifyDroppedAttachments: vi.fn(async () => {}),
}));

vi.mock("./prompt-delivery", () => ({
  deliverPrompt: vi.fn(),
}));

vi.mock("../app-home/models", () => ({
  getAvailableModels: vi.fn(),
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

vi.mock("../slack-settings", () => ({
  getSlackSettings: vi.fn(),
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

const noRepositoryTarget: SlackSessionTarget = { kind: "none" };

const actor: SlackActorIdentity = {
  userId: "U123",
  senderLabel: "Display Name (U123)",
  displayName: "Display Name",
  email: "user@example.com",
};

describe("startSessionAndSendPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAvailableModels).mockResolvedValue([
      { label: "GPT 5.4", value: "openai/gpt-5.4" },
      { label: "Claude Sonnet", value: "anthropic/claude-sonnet-4-6" },
    ]);
    vi.mocked(getSlackSettings).mockResolvedValue({
      defaultModel: "anthropic/claude-sonnet-4-6",
    });
    vi.mocked(getResolvedUserPreferences).mockResolvedValue({
      model: "openai/gpt-5.4",
      reasoningEffort: "high",
      branch: "user-default-branch",
    });
    vi.mocked(getUserRepoBranchPreference).mockResolvedValue("repo-override-branch");
    vi.mocked(createSession).mockResolvedValue({ sessionId: "session-1", status: "created" });
    vi.mocked(preparePromptImageAttachments).mockResolvedValue({ files: [], dropped: [] });
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
        actor,
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

  it("appends configured session instructions to the first prompt", async () => {
    const env = makeEnv();
    vi.mocked(getSlackSettings).mockResolvedValue({
      defaultModel: "anthropic/claude-sonnet-4-6",
      sessionInstructions: "Always run tests before pushing changes.",
    });

    await startSessionAndSendPrompt(env, {
      target: repositoryTarget,
      channel: "C123",
      threadTs: "111.222",
      messageText: "Fix the failing deploy",
      actor,
      traceId: "trace-1",
    });

    expect(deliverPrompt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        content:
          "Fix the failing deploy\n\n## Additional Instructions\n\n" +
          "Always run tests before pushing changes.",
      })
    );
  });

  it("passes stable create and prompt ids and saves a new session before delivery", async () => {
    const env = makeEnv();
    const onLaunchPrepared = vi.fn(async () => {});
    const onSessionCreated = vi.fn(async () => {});

    await startSessionAndSendPrompt(env, {
      target: repositoryTarget,
      channel: "C123",
      threadTs: "111.222",
      messageText: "Fix it",
      actor,
      clientRequestId: "request-1",
      onLaunchPrepared,
      onSessionCreated,
    });

    expect(createSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ clientRequestId: "request-1" })
    );
    expect(onSessionCreated).toHaveBeenCalledWith("session-1");
    expect(onLaunchPrepared).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai/gpt-5.4", content: "Fix it" }),
      undefined
    );
    expect(deliverPrompt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ sessionId: "session-1", clientRequestId: "request-1" })
    );
    expect(onLaunchPrepared.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(createSession).mock.invocationCallOrder[0]!
    );
    expect(vi.mocked(createSession).mock.invocationCallOrder[0]).toBeLessThan(
      onSessionCreated.mock.invocationCallOrder[0]!
    );
    expect(onSessionCreated.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deliverPrompt).mock.invocationCallOrder[0]!
    );
  });

  it("replays a persisted snapshot without re-resolving mutable settings", async () => {
    const env = makeEnv();
    const launchSnapshot = {
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "medium",
      branch: "saved-branch",
      content: "Saved prompt content",
      callbackContext: {
        source: "slack" as const,
        channel: "C123",
        threadTs: "111.222",
        repoFullName: "acme/app",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "medium",
      },
      attachmentReferences: [{ attachmentId: "att-saved", name: "saved.png" }],
    };

    await startSessionAndSendPrompt(env, {
      target: repositoryTarget,
      channel: "C123",
      threadTs: "111.222",
      messageText: "Changed prompt content",
      actor,
      clientRequestId: "request-1",
      launchSnapshot,
    });

    expect(getAvailableModels).not.toHaveBeenCalled();
    expect(getSlackSettings).not.toHaveBeenCalled();
    expect(getResolvedUserPreferences).not.toHaveBeenCalled();
    expect(getUserRepoBranchPreference).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        model: launchSnapshot.model,
        reasoningEffort: launchSnapshot.reasoningEffort,
        branch: launchSnapshot.branch,
      })
    );
    expect(deliverPrompt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        content: launchSnapshot.content,
        callbackContext: launchSnapshot.callbackContext,
        attachmentReferences: launchSnapshot.attachmentReferences,
      })
    );
  });

  it("reuses an existing session without creating or persisting it again", async () => {
    const env = makeEnv();
    const onSessionCreated = vi.fn(async () => {});

    await expect(
      startSessionAndSendPrompt(env, {
        target: repositoryTarget,
        channel: "C123",
        threadTs: "111.222",
        messageText: "Fix it",
        actor,
        clientRequestId: "request-1",
        existingSessionId: "session-existing",
        onSessionCreated,
      })
    ).resolves.toEqual({ sessionId: "session-existing" });

    expect(createSession).not.toHaveBeenCalled();
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(deliverPrompt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ sessionId: "session-existing", clientRequestId: "request-1" })
    );
  });

  it("replaces a persisted session that disappeared before prompt delivery", async () => {
    const env = makeEnv();
    const onSessionCreated = vi.fn(async () => {});
    vi.mocked(deliverPrompt)
      .mockResolvedValueOnce({ ok: false, reason: "stale" })
      .mockResolvedValueOnce({ ok: true, data: { messageId: "message-2" } });
    vi.mocked(createSession).mockResolvedValue({ sessionId: "session-2", status: "created" });

    await expect(
      startSessionAndSendPrompt(env, {
        target: repositoryTarget,
        channel: "C123",
        threadTs: "111.222",
        messageText: "Fix it",
        actor,
        clientRequestId: "request-1",
        existingSessionId: "session-missing",
        onSessionCreated,
      })
    ).resolves.toEqual({ sessionId: "session-2" });

    expect(createSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ clientRequestId: "request-1" })
    );
    expect(onSessionCreated).toHaveBeenCalledWith("session-2", "session-missing");
    expect(deliverPrompt).toHaveBeenNthCalledWith(
      1,
      env,
      expect.objectContaining({ sessionId: "session-missing" })
    );
    expect(deliverPrompt).toHaveBeenNthCalledWith(
      2,
      env,
      expect.objectContaining({ sessionId: "session-2" })
    );
  });

  it("reinitializes and retries a stale persisted session with the same id", async () => {
    const env = makeEnv();
    const onSessionCreated = vi.fn(async () => {});
    vi.mocked(deliverPrompt)
      .mockResolvedValueOnce({ ok: false, reason: "stale" })
      .mockResolvedValueOnce({ ok: true, data: { messageId: "message-2" } });
    vi.mocked(createSession).mockResolvedValue({
      sessionId: "session-existing",
      status: "created",
    });

    await expect(
      startSessionAndSendPrompt(env, {
        target: repositoryTarget,
        channel: "C123",
        threadTs: "111.222",
        messageText: "Fix it",
        actor,
        clientRequestId: "request-1",
        existingSessionId: "session-existing",
        onSessionCreated,
      })
    ).resolves.toEqual({ sessionId: "session-existing" });

    expect(createSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ clientRequestId: "request-1" })
    );
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(deliverPrompt).toHaveBeenCalledTimes(2);
  });

  it("returns failure without delivering when launch-state persistence fails", async () => {
    const env = makeEnv();

    await expect(
      startSessionAndSendPrompt(env, {
        target: repositoryTarget,
        channel: "C123",
        threadTs: "111.222",
        messageText: "Fix it",
        actor,
        onSessionCreated: vi.fn(async () => {
          throw new Error("KV unavailable");
        }),
      })
    ).resolves.toBeNull();

    expect(deliverPrompt).not.toHaveBeenCalled();
    expect(storeThreadSession).not.toHaveBeenCalled();
  });

  it("does not apply repository branch overrides to environment sessions", async () => {
    const env = makeEnv();

    await startSessionAndSendPrompt(env, {
      target: environmentTarget,
      channel: "C123",
      threadTs: "111.222",
      messageText: "Inspect production",
      actor,
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

  it("launches no-repository sessions without branch preferences", async () => {
    const env = makeEnv();

    await startSessionAndSendPrompt(env, {
      target: noRepositoryTarget,
      channel: "C123",
      threadTs: "111.222",
      messageText: "Research this without cloning a repository",
      actor,
    });

    expect(getUserRepoBranchPreference).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ target: noRepositoryTarget, branch: undefined })
    );
    expect(deliverPrompt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        callbackContext: expect.objectContaining({ repoFullName: "No repository" }),
      })
    );
    expect(buildThreadSession).toHaveBeenCalledWith(
      "session-1",
      noRepositoryTarget,
      "openai/gpt-5.4",
      "high",
      undefined
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
        actor,
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
        actor,
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
    const contextImages: SlackImageAttachment[] = [
      {
        id: "F2",
        name: "earlier.png",
        mimetype: "image/png",
        downloadUrl: "https://files.slack.com/earlier.png",
      },
    ];
    vi.mocked(preparePromptImageAttachments).mockResolvedValue(prepared);
    const env = makeEnv();

    await expect(
      startSessionAndSendPrompt(env, {
        target: repositoryTarget,
        channel: "C123",
        threadTs: "111.222",
        messageText: "What is wrong in this screenshot?",
        actor,
        images,
        contextImages,
        traceId: "trace-1",
      })
    ).resolves.toEqual({ sessionId: "session-1" });

    expect(preparePromptImageAttachments).toHaveBeenCalledWith(
      env,
      images,
      contextImages,
      "trace-1"
    );
    const prepareOrder = vi.mocked(preparePromptImageAttachments).mock.invocationCallOrder[0]!;
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
    vi.mocked(preparePromptImageAttachments).mockResolvedValue({
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
        actor,
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
    vi.mocked(preparePromptImageAttachments).mockResolvedValue({
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
        actor,
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
