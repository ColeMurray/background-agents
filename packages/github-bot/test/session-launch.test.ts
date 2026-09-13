import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionInputSchema,
  sendPromptRequestSchema,
} from "@open-inspect/shared/types/session-api";
import { signedControlPlaneFetch } from "../src/internal-auth";
import { launchSession } from "../src/session-launch";
import { resolveSessionTarget } from "../src/session-target";
import type { Logger } from "../src/logger";
import type { Env } from "../src/types";

vi.mock("../src/internal-auth", () => ({ signedControlPlaneFetch: vi.fn() }));
vi.mock("../src/session-target", () => ({ resolveSessionTarget: vi.fn() }));

const env = {} as Env;
const log: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
};
const params = {
  owner: "Acme",
  repoName: "Widgets",
  sender: { login: "alice", id: 1001, avatar_url: "https://example.com/alice.png" },
  config: {
    model: "openai/gpt-5",
    reasoningEffort: "high",
    autoReviewOnOpen: true,
    enabledRepos: null,
    allowedTriggerUsers: null,
    codeReviewInstructions: null,
    commentActionInstructions: null,
  },
  ghToken: "installation-token",
  traceId: "trace-launch",
  pullNumber: 42,
  title: "GitHub: Review PR #42",
  action: "review",
  buildPrompt: vi.fn(() => "Review this PR"),
};

beforeEach(() => {
  vi.resetAllMocks();
  params.buildPrompt.mockReturnValue("Review this PR");
  vi.mocked(resolveSessionTarget).mockResolvedValue({ repoOwner: "Acme", repoName: "Widgets" });
  vi.mocked(signedControlPlaneFetch).mockImplementation(async (_env, request) =>
    Response.json(
      request.url === "https://internal/sessions"
        ? { sessionId: "session-123", status: "created" }
        : { messageId: "msg-456" }
    )
  );
});

describe("launchSession", () => {
  it.each([{ repoOwner: "Acme", repoName: "Widgets" }, { environmentId: "env-123" }])(
    "launches the resolved target %j in order with actor and config mapping",
    async (target) => {
      const steps: string[] = [];
      vi.mocked(resolveSessionTarget).mockImplementation(async () => {
        steps.push("resolve");
        return target;
      });
      vi.mocked(signedControlPlaneFetch).mockImplementation(async (_env, request) => {
        const creating = request.url === "https://internal/sessions";
        steps.push(creating ? "create" : "send");
        return Response.json(
          creating ? { sessionId: "session-123", status: "created" } : { messageId: "msg-456" }
        );
      });
      vi.mocked(log.info).mockImplementation((event) => {
        steps.push(event);
      });
      params.buildPrompt.mockImplementation(() => {
        steps.push("build");
        return "Review this PR";
      });

      await expect(launchSession(env, log, params)).resolves.toEqual({
        outcome: "processed",
        session_id: "session-123",
        message_id: "msg-456",
        handler_action: "review",
      });
      expect(steps).toEqual([
        "resolve",
        "create",
        "session.created",
        "build",
        "send",
        "prompt.sent",
      ]);
      expect(resolveSessionTarget).toHaveBeenCalledWith(env, log, {
        owner: params.owner,
        repoName: params.repoName,
        senderLogin: "alice",
        config: params.config,
        ghToken: params.ghToken,
        traceId: params.traceId,
      });
      const requests = vi.mocked(signedControlPlaneFetch).mock.calls.map(([, request]) => request);
      expect(requests).toEqual([
        {
          method: "POST",
          url: "https://internal/sessions",
          actor: "github:1001",
          traceId: params.traceId,
          body: expect.any(String),
        },
        {
          method: "POST",
          url: "https://internal/sessions/session-123/prompt",
          actor: "github:1001",
          traceId: params.traceId,
          body: expect.any(String),
        },
      ]);
      const sessionBody = JSON.parse(requests[0].body!);
      expect(sessionBody).toEqual({
        ...target,
        title: params.title,
        model: params.config.model,
        reasoningEffort: "high",
        scmLogin: "alice",
        actorAvatarUrl: params.sender.avatar_url,
      });
      expect(createSessionInputSchema.parse(sessionBody)).toEqual(sessionBody);
      const promptBody = JSON.parse(requests[1].body!);
      expect(promptBody).toEqual({
        content: "Review this PR",
        source: "github",
      });
      expect(sendPromptRequestSchema.parse(promptBody)).toEqual(promptBody);
      const meta = {
        trace_id: params.traceId,
        repo: "acme/widgets",
        pull_number: 42,
        session_id: "session-123",
      };
      expect(log.info).toHaveBeenNthCalledWith(1, "session.created", { ...meta, action: "review" });
      expect(log.info).toHaveBeenNthCalledWith(2, "prompt.sent", {
        ...meta,
        message_id: "msg-456",
        source: "github",
        content_length: "Review this PR".length,
      });
    }
  );

  it("omits an unset reasoning effort", async () => {
    await launchSession(env, log, {
      ...params,
      config: { ...params.config, reasoningEffort: null },
    });
    const request = vi.mocked(signedControlPlaneFetch).mock.calls[0][1];
    expect(JSON.parse(request.body!)).not.toHaveProperty("reasoningEffort");
  });

  it("stops if target resolution rejects", async () => {
    vi.mocked(resolveSessionTarget).mockRejectedValue(new Error("target failed"));
    await expect(launchSession(env, log, params)).rejects.toThrow("target failed");
    expect(signedControlPlaneFetch).not.toHaveBeenCalled();
    expect(params.buildPrompt).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it.each(["create", "send"])(
    "propagates %s failures without advancing or retrying",
    async (stage) => {
      const error = new Error("network failed");
      vi.mocked(signedControlPlaneFetch).mockImplementation(async (_env, request) => {
        if (stage === "create" || request.url.endsWith("/prompt")) throw error;
        return Response.json({ sessionId: "session-123", status: "created" });
      });
      await expect(launchSession(env, log, params)).rejects.toBe(error);
      expect(signedControlPlaneFetch).toHaveBeenCalledTimes(stage === "create" ? 1 : 2);
      expect(params.buildPrompt).toHaveBeenCalledTimes(stage === "create" ? 0 : 1);
      expect(log.info).toHaveBeenCalledTimes(stage === "create" ? 0 : 1);
    }
  );

  it.each([
    ["create", "http", "Session creation failed: 500 unavailable"],
    ["create", "schema", "Session creation failed: invalid response"],
    ["create", "json", ""],
    ["send", "http", "Prompt delivery failed: 500 unavailable"],
    ["send", "schema", "Prompt delivery failed: invalid response"],
    ["send", "json", ""],
  ])("rejects %s %s errors", async (stage, failure, message) => {
    vi.mocked(signedControlPlaneFetch).mockImplementation(async (_env, request) => {
      if (stage === "send" && request.url === "https://internal/sessions") {
        return Response.json({ sessionId: "session-123", status: "created" });
      }
      if (failure === "http") return new Response("unavailable", { status: 500 });
      if (failure === "json") return new Response("not json");
      return Response.json({});
    });
    await expect(launchSession(env, log, params)).rejects.toThrow(
      failure === "json" ? SyntaxError : message
    );
    expect(signedControlPlaneFetch).toHaveBeenCalledTimes(stage === "create" ? 1 : 2);
    expect(params.buildPrompt).toHaveBeenCalledTimes(stage === "create" ? 0 : 1);
    expect(log.info).toHaveBeenCalledTimes(stage === "create" ? 0 : 1);
  });

  it("does not deliver a prompt if its builder throws", async () => {
    params.buildPrompt.mockImplementation(() => {
      throw new Error("prompt failed");
    });
    await expect(launchSession(env, log, params)).rejects.toThrow("prompt failed");
    expect(signedControlPlaneFetch).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
