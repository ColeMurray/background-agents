import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SLACK_CLASSIFICATION_MAX_PROMPT_LENGTH,
  SLACK_OAUTH_CLASSIFICATION_SERVER_TIMEOUT_MS,
} from "@open-inspect/shared/slack-classification";
import { ScopedOAuthSecretsStore } from "../db/scoped-oauth-secrets";
import { ProviderDefaultStore } from "../db/provider-account-defaults";
import { ModelProviderAccountBroker } from "../auth/model-provider-account-broker";
import { OpenAITokenBroker } from "../auth/openai-token-broker";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import {
  createTestEnv,
  createTestRequestHandler,
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import { slackClassificationRoutes } from "./slack-classification";

const handle = createTestRequestHandler([slackClassificationRoutes]);
const URL = "https://internal/slack/target-classifications";
const decision = {
  targetId: "acme/prod",
  confidence: "high",
  reasoning: "The service is named.",
  alternatives: [],
};

function completed(output: unknown): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        output: [
          { type: "function_call", name: "classify_target", arguments: JSON.stringify(output) },
        ],
      },
    })}\n\n`
  );
}

describe("Slack global OAuth classification route", () => {
  const upstream = vi.fn();
  const env = createTestEnv({
    ...TEST_SERVICE_SECRETS,
    SLACK_CLASSIFICATION_MODEL: "openai/gpt-5.6-luna",
    EGRESS: { fetch: upstream },
  });
  let readSecrets: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    upstream.mockReset().mockResolvedValue(completed(decision));
    vi.spyOn(ProviderDefaultStore.prototype, "get").mockResolvedValue(null);
    readSecrets = vi.spyOn(ScopedOAuthSecretsStore.prototype, "read").mockResolvedValue({
      OPENAI_OAUTH_REFRESH_TOKEN: "private-refresh-token",
      OPENAI_OAUTH_ACCESS_TOKEN: "private-access-token",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
      OPENAI_OAUTH_ACCOUNT_ID: "account-1",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function request(
    body: unknown = { prompt: "fix prod alerts" },
    service: "slack-bot" | "linear-bot" | "web" = "slack-bot"
  ) {
    return signedServiceRequest(URL, { method: "POST", service, body: JSON.stringify(body) });
  }

  it("uses only the global credential, sends it only through egress, and returns only a decision", async () => {
    upstream.mockResolvedValue(completed({ ...decision, accessToken: "private-access-token" }));
    const response = await handle(await request(), env, TEST_BACKGROUND_TASK_CONTEXT);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(decision);
    expect(readSecrets).toHaveBeenCalledExactlyOnceWith({ kind: "global" });
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer private-access-token");
    expect(headers.get("ChatGPT-Account-Id")).toBe("account-1");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      stream: true,
    });
  });

  it("accepts a complete prompt at the documented limit without truncation", async () => {
    const prompt = "x".repeat(SLACK_CLASSIFICATION_MAX_PROMPT_LENGTH);
    const response = await handle(await request({ prompt }), env, TEST_BACKGROUND_TASK_CONTEXT);
    expect(response.status).toBe(200);
    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).input[0].content[0].text).toBe(prompt);
  });

  it("uses the installation default ChatGPT account from the current managed OAuth flow", async () => {
    vi.mocked(ProviderDefaultStore.prototype.get).mockResolvedValue({
      provider: "openai",
      providerAccountId: "mpa_default",
      unattendedMode: "provider_account",
      createdBy: null,
      updatedBy: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const broker = vi.spyOn(ModelProviderAccountBroker.prototype, "getAccess").mockResolvedValue({
      accessToken: "managed-account-token",
      externalAccountId: "managed-account",
      credentialVersion: 1,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    const response = await handle(await request(), env, TEST_BACKGROUND_TASK_CONTEXT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(decision);
    expect(ProviderDefaultStore.prototype.get).toHaveBeenCalledExactlyOnceWith("openai");
    expect(broker).toHaveBeenCalledExactlyOnceWith("mpa_default", "openai", {
      deadlineAt: expect.any(Number),
    });
    expect(readSecrets).not.toHaveBeenCalled();
    const headers = new Headers(upstream.mock.calls[0][1].headers);
    expect(headers.get("Authorization")).toBe("Bearer managed-account-token");
    expect(headers.get("ChatGPT-Account-Id")).toBe("managed-account");
  });

  it.each(["unattended access disabled", "account unavailable"])(
    "does not fall back to legacy OAuth when %s",
    async (failure) => {
      vi.mocked(ProviderDefaultStore.prototype.get).mockResolvedValue({
        provider: "openai",
        providerAccountId: "mpa_default",
        unattendedMode: failure === "unattended access disabled" ? "api_key" : "provider_account",
        createdBy: null,
        updatedBy: null,
        createdAt: 1,
        updatedAt: 1,
      });
      vi.spyOn(ModelProviderAccountBroker.prototype, "getAccess").mockRejectedValue(
        new Error("account unavailable")
      );
      const response = await handle(await request(), env, TEST_BACKGROUND_TASK_CONTEXT);
      expect(response.status).toBe(failure === "unattended access disabled" ? 503 : 502);
      expect(readSecrets).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    }
  );

  it.each(["linear-bot", "web"] as const)(
    "refuses the signed %s service before reading credentials",
    async (service) => {
      const response = await handle(
        await request(undefined, service),
        env,
        TEST_BACKGROUND_TASK_CONTEXT
      );
      expect(response.status).toBe(403);
      expect(readSecrets).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    }
  );

  it("refuses an unsigned request", async () => {
    const response = await handle(
      new Request(URL, { method: "POST", body: "{}" }),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );
    expect(response.status).toBe(401);
    expect(readSecrets).not.toHaveBeenCalled();
  });

  it.each([
    ["missing prompt", {}],
    ["empty prompt", { prompt: "" }],
    ["oversized prompt", { prompt: "x".repeat(SLACK_CLASSIFICATION_MAX_PROMPT_LENGTH + 1) }],
    ["model override", { prompt: "fix prod alerts", model: "other-model" }],
  ])("rejects %s before reading credentials", async (_name, body) => {
    const response = await handle(await request(body), env, TEST_BACKGROUND_TASK_CONTEXT);
    expect(response.status).toBe(400);
    expect(readSecrets).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([{ SLACK_CLASSIFICATION_MODEL: undefined }, { EGRESS: undefined }])(
    "fails closed without model opt-in or egress: %j",
    async (overrides) => {
      const response = await handle(
        await request(),
        { ...env, ...overrides },
        TEST_BACKGROUND_TASK_CONTEXT
      );
      expect(response.status).toBe(503);
      expect(readSecrets).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    }
  );

  it("returns an unavailable result when only non-global OAuth is configured", async () => {
    readSecrets.mockImplementation(async (scope: { kind: string }) =>
      scope.kind === "global"
        ? {}
        : {
            OPENAI_OAUTH_REFRESH_TOKEN: "repo-only-token",
          }
    );
    const response = await handle(await request(), env, TEST_BACKGROUND_TASK_CONTEXT);
    expect(response.status).toBe(503);
    expect(readSecrets).toHaveBeenCalledExactlyOnceWith({ kind: "global" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["legacy", "managed"])(
    "retains %s credential settlement after the HTTP deadline",
    async (kind) => {
      const signed = await request();
      vi.useFakeTimers();
      const background = createTestBackgroundTasks();
      let release!: () => void;
      const refreshResponse = new Promise<void>((resolve) => {
        release = resolve;
      });
      const persist = vi.fn().mockResolvedValue(undefined);
      const acquire = vi.fn(async () => {
        await refreshResponse;
        await persist();
        // Managed refresh can commit a rotation and then reject the expired caller.
        if (kind === "managed") throw new Error("Caller deadline expired after settlement");
        return {
          accessToken: "rotated-token",
          credentialVersion: 2,
          expiresAt: Date.now() + 60_000,
        };
      });
      if (kind === "legacy") {
        vi.spyOn(OpenAITokenBroker.prototype, "refreshGlobal").mockImplementation(acquire);
      } else {
        vi.mocked(ProviderDefaultStore.prototype.get).mockResolvedValue({
          provider: "openai",
          providerAccountId: "mpa_default",
          unattendedMode: "provider_account",
          createdBy: null,
          updatedBy: null,
          createdAt: 1,
          updatedAt: 1,
        });
        vi.spyOn(ModelProviderAccountBroker.prototype, "getAccess").mockImplementation(acquire);
      }

      try {
        const operation = handle(signed, env, background);
        await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(SLACK_OAUTH_CLASSIFICATION_SERVER_TIMEOUT_MS);
        expect((await operation).status).toBe(502);
        expect(upstream).not.toHaveBeenCalled();
        expect(persist).not.toHaveBeenCalled();
        expect(background.submissions).toHaveLength(1);
        let settled = false;
        const settlement = background.settle().then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        release();
        await settlement;
        expect(persist).toHaveBeenCalledOnce();
        expect(settled).toBe(true);
        expect(background.failures).toEqual([]);
        expect(upstream).not.toHaveBeenCalled();
      } finally {
        release();
        await background.settle();
      }
    }
  );

  it.each([
    () => new Response("<html>private-access-token</html>", { status: 403 }),
    () => completed({ ...decision, confidence: "invalid", reasoning: "private-refresh-token" }),
  ])("sanitizes upstream failures and invalid decisions", async (response) => {
    upstream.mockResolvedValue(response());
    const result = await handle(await request(), env, TEST_BACKGROUND_TASK_CONTEXT);
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ error: "Slack OAuth classification unavailable" });
  });
});
