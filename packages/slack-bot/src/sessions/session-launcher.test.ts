import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import { postMessage } from "@open-inspect/shared/slack";
import type * as SlackModule from "@open-inspect/shared/slack";
import type { Env } from "../types";
import type { SlackSessionTarget } from "../targets";
import type { SlackActorIdentity } from "../user-identity";
import { getUserRepoBranchPreference } from "../branch-preferences";
import type * as BranchPreferencesModule from "../branch-preferences";
import { createSession } from "./control-plane-client";
import { deliverPrompt } from "./prompt-delivery";
import { buildThreadSession, storeThreadSession } from "./thread-session-store";
import type * as ThreadSessionStoreModule from "./thread-session-store";
import {
  startSessionAndSendPrompt,
  storedSlackHarnessesAreAvailable,
  type SlackLaunchSettings,
} from "./session-launcher";
import { transitionSlackIngress } from "../ingress-authority";

vi.mock("@open-inspect/shared/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof SlackModule>()),
  postMessage: vi.fn(),
}));

vi.mock("../attachments", () => ({
  preparePromptImageAttachments: vi.fn(async () => ({ files: [], dropped: [] })),
  notifyDroppedAttachments: vi.fn(),
}));

vi.mock("../branch-preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof BranchPreferencesModule>()),
  getUserRepoBranchPreference: vi.fn(),
}));
vi.mock("./control-plane-client", () => ({ createSession: vi.fn() }));
vi.mock("./prompt-delivery", () => ({ deliverPrompt: vi.fn() }));
vi.mock("../ingress-authority", () => ({ transitionSlackIngress: vi.fn() }));
vi.mock("./thread-session-store", async (importOriginal) => {
  const actual = await importOriginal<typeof ThreadSessionStoreModule>();
  return {
    ...actual,
    buildThreadSession: vi.fn(actual.buildThreadSession),
    storeThreadSession: vi.fn(),
  };
});

function makeEnv(): Env {
  return { SLACK_BOT_TOKEN: "xoxb-test", LOG_LEVEL: "error" } as Env;
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
const noRepositoryTarget: SlackSessionTarget = { kind: "none" };
const actor: SlackActorIdentity = {
  userId: "U123",
  senderLabel: "Display Name (U123)",
  displayName: "Display Name",
  email: "user@example.com",
};
const launchSettings: SlackLaunchSettings = {
  modelSource: "app-home",
  enabledModels: ["openai/gpt-5.4"],
  slackConfig: { harness: "opencode" },
  userPreferences: {
    model: "openai/gpt-5.4",
    modelOrigin: "app-home",
    reasoningEffort: "high",
    branch: "user-default-branch",
    harness: "opencode",
  },
};
const options = {
  target: repositoryTarget,
  channel: "C123",
  threadTs: "111.222",
  messageText: "Fix it",
  actor,
  launchSettings,
};

describe("stored Slack harness availability", () => {
  it("refuses instead of falling back when a stored harness is unavailable", () => {
    expect(storedSlackHarnessesAreAvailable("pi", undefined, ["opencode"])).toBe(false);
    expect(storedSlackHarnessesAreAvailable("opencode", "pi", ["opencode"])).toBe(false);
    expect(storedSlackHarnessesAreAvailable("pi", "pi", ["opencode", "pi"])).toBe(true);
  });
});

describe("startSessionAndSendPrompt team boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserRepoBranchPreference).mockResolvedValue("repo-override-branch");
    vi.mocked(createSession).mockResolvedValue({ sessionId: "session-1", status: "created" });
    vi.mocked(deliverPrompt).mockResolvedValue({ ok: true, data: { messageId: "message-1" } });
    vi.mocked(postMessage).mockResolvedValue({ ok: true, channel: "C123", ts: "111.333" });
    vi.mocked(transitionSlackIngress).mockResolvedValue(true);
  });

  it("starts repository-backed Pi sessions through the control plane", async () => {
    const piSettings: SlackLaunchSettings = {
      ...launchSettings,
      enabledModels: ["openai/gpt-5.6-sol"],
      userPreferences: {
        ...launchSettings.userPreferences,
        harness: "pi",
        model: "openai/gpt-5.6-sol",
      },
    };

    const env = makeEnv();
    await expect(
      startSessionAndSendPrompt(env, { ...options, launchSettings: piSettings })
    ).resolves.toEqual(expect.objectContaining({ sessionId: "session-1" }));
    expect(createSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ target: repositoryTarget, harness: "pi" })
    );
    expect(deliverPrompt).toHaveBeenCalled();
  });

  it("persists durable session and mapping stages around one stable prompt", async () => {
    vi.mocked(createSession).mockResolvedValueOnce({
      sessionId: "slack-session-1",
      status: "created",
    });
    const env = makeEnv();
    const ingress = {
      receiptId: "r1",
      leaseOwner: "w1",
      stableSessionId: "slack-session-1",
      stableMessageId: "slack-message-1",
      state: "processing",
      sessionId: null,
    };
    await expect(startSessionAndSendPrompt(env, { ...options, ingress })).resolves.toMatchObject({
      sessionId: "slack-session-1",
    });
    expect(createSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ ingress: { receiptId: "r1", sessionId: "slack-session-1" } })
    );
    expect(deliverPrompt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ clientRequestId: "slack-message-1" })
    );
    expect(vi.mocked(transitionSlackIngress).mock.calls.map((call) => [call[3], call[4]])).toEqual([
      ["processing", "session_created"],
      ["session_created", "prompt_queued"],
      ["prompt_queued", "completed"],
    ]);
    expect(storeThreadSession).toHaveBeenCalledOnce();
  });

  it.each([
    [
      { status: 403, code: "session_action_denied", reasonCode: "not_member" },
      "you are not a member of this channel's team",
    ],
    [{ status: 403, code: "not_member" }, "you are not a member of this channel's team"],
    [
      { status: 409, code: "target_team_missing_grant", repository: "acme/private" },
      "This channel's team does not have access to repository acme/private.",
    ],
  ] as const)("does not prompt or store on create refusal: %s", async (error, message) => {
    vi.mocked(createSession).mockResolvedValue({ error });
    const env = makeEnv();

    expect(await startSessionAndSendPrompt(env, { ...options, teamId: "team-a" })).toBeNull();
    expect(postMessage).toHaveBeenCalledWith("xoxb-test", "C123", message, {
      thread_ts: "111.222",
    });
    expect(deliverPrompt).not.toHaveBeenCalled();
    expect(buildThreadSession).not.toHaveBeenCalled();
    expect(storeThreadSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      target: repositoryTarget,
      teamId: "team-a",
      branch: "repo-override-branch",
      repoId: "acme/app",
      repoFullName: "acme/app",
    },
    {
      target: noRepositoryTarget,
      teamId: null,
      branch: undefined,
      repoId: "__no_repository__",
      repoFullName: "No repository",
    },
  ])(
    "preserves $target.kind scope $teamId through creation and thread storage",
    async ({ target, teamId, branch, repoId, repoFullName }) => {
      const env = makeEnv();

      expect(await startSessionAndSendPrompt(env, { ...options, target, teamId })).toEqual(
        expect.objectContaining({ sessionId: "session-1" })
      );
      expect(createSession).toHaveBeenCalledWith(
        env,
        expect.objectContaining({ target, teamId, branch })
      );
      if (target.kind === "none") expect(getUserRepoBranchPreference).not.toHaveBeenCalled();
      expect(deliverPrompt).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          sessionId: "session-1",
          authorId: "slack:U123",
          channel: "C123",
          threadTs: "111.222",
          callbackContext: expect.objectContaining({ repoFullName }),
        })
      );
      expect(buildThreadSession).toHaveBeenCalledWith(
        "session-1",
        target,
        "openai/gpt-5.4",
        "high",
        undefined,
        teamId,
        "opencode"
      );
      expect(storeThreadSession).toHaveBeenCalledWith(
        env,
        "C123",
        "111.222",
        expect.objectContaining({ sessionId: "session-1", teamId, repoId, repoFullName })
      );
    }
  );
});

describe("startSessionAndSendPrompt harness", () => {
  const anthropicModel = "anthropic/claude-haiku-4-5";
  const openAIModel = "openai/gpt-5.4";

  function settings(harness: HarnessId, preferredModel: string): SlackLaunchSettings {
    return {
      modelSource: "app-home",
      enabledModels: [anthropicModel, openAIModel],
      slackConfig: { harness: "opencode" },
      userPreferences: {
        model: preferredModel,
        modelOrigin: "app-home",
        reasoningEffort: undefined,
        branch: undefined,
        harness,
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserRepoBranchPreference).mockResolvedValue(undefined);
    vi.mocked(createSession).mockResolvedValue({ sessionId: "session-1", status: "created" });
    vi.mocked(deliverPrompt).mockResolvedValue({ ok: true, data: { messageId: "message-1" } });
  });

  it.each([
    ["OpenCode with an Anthropic model", "opencode", anthropicModel],
    ["OpenCode with an OpenAI model", "opencode", openAIModel],
    ["Claude Agent with an Anthropic model", "claude", anthropicModel],
  ] as const)("creates %s on the user's harness", async (_case, harness, model) => {
    const env = makeEnv();

    expect(
      await startSessionAndSendPrompt(env, { ...options, launchSettings: settings(harness, model) })
    ).toEqual(expect.objectContaining({ sessionId: "session-1" }));
    expect(createSession).toHaveBeenCalledWith(env, expect.objectContaining({ harness, model }));
  });

  it("refuses a model the user's harness cannot run without creating a session", async () => {
    const env = makeEnv();

    expect(
      await startSessionAndSendPrompt(env, {
        ...options,
        launchSettings: settings("claude", openAIModel),
      })
    ).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      env.SLACK_BOT_TOKEN,
      "C123",
      'Model "openai/gpt-5.4" cannot run on the Claude Agent harness. Start your request with `!model` and a model Claude Agent can run, or change your model or agent harness in the Slack app\'s Home tab.',
      { thread_ts: "111.222" }
    );
  });

  it("refuses a disabled planned model before checking harness compatibility", async () => {
    const env = makeEnv();

    expect(
      await startSessionAndSendPrompt(env, {
        ...options,
        launchSettings: {
          ...settings("claude", "anthropic/claude-sonnet-4-6"),
          enabledModels: [openAIModel, anthropicModel],
        },
        launchPlan: { sessionDefaults: { model: "anthropic/claude-sonnet-4-6" } },
      })
    ).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(deliverPrompt).not.toHaveBeenCalled();
    expect(storeThreadSession).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      env.SLACK_BOT_TOKEN,
      "C123",
      'Your requested model "Claude Sonnet 4.6" is no longer enabled. Start a new request with `!model` and an enabled model.',
      { thread_ts: "111.222" }
    );
  });

  it.each(["high", "xhigh"] as const)(
    "does not replace a disabled planned model with %s reasoning",
    async (reasoningEffort) => {
      const env = makeEnv();

      expect(
        await startSessionAndSendPrompt(env, {
          ...options,
          launchSettings: {
            ...settings("opencode", anthropicModel),
            enabledModels: [anthropicModel],
          },
          launchPlan: { sessionDefaults: { model: "openai/gpt-5.6-sol", reasoningEffort } },
        })
      ).toBeNull();

      expect(createSession).not.toHaveBeenCalled();
      expect(deliverPrompt).not.toHaveBeenCalled();
      expect(storeThreadSession).not.toHaveBeenCalled();
    }
  );

  it("allows an enabled planned model to override disabled user defaults", async () => {
    const env = makeEnv();

    await startSessionAndSendPrompt(env, {
      ...options,
      launchSettings: { ...settings("opencode", openAIModel), enabledModels: [anthropicModel] },
      launchPlan: { sessionDefaults: { model: anthropicModel, reasoningEffort: "high" } },
    });

    expect(createSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        model: anthropicModel,
        reasoningEffort: "high",
      })
    );
  });
});
