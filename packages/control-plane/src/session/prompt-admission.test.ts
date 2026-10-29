import { describe, expect, it, vi } from "vitest";
import { MAX_UNFINISHED_PROMPTS } from "@open-inspect/shared/types/prompts";
import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import type { MessageRepository } from "./message-repository";
import type { SessionMessenger } from "./messenger";
import type { ParticipantRepository } from "./participant-repository";
import type { ParticipantService } from "./participant-service";
import {
  BudgetExhaustedError,
  fingerprintWebPrompt,
  HarnessModelIncompatibleError,
  type PromptPolicy,
  PromptQueueFullError,
  PromptRequestConflictError,
  SandboxPromptBlockedError,
  SessionNotPromptableError,
  SessionPromptAdmission,
} from "./prompt-admission";
import {
  AttachmentClaimConflictError,
  type SessionAttachmentRepository,
} from "./session-attachment-repository";
import { SessionAttachmentError } from "./session-attachment-resolver";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionStatusService } from "./session-status-service";
import type { MessageRow, ParticipantRow, SessionRow } from "./types";

const client = { participantId: "part-1", userId: "user-1", name: "User" };
const prompt = { content: "Continue", clientRequestId: "request-1" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function buildAdmission() {
  const session: SessionRow = {
    id: "sess-1",
    session_name: "s1",
    title: "Session",
    repo_owner: "acme",
    repo_name: "repo",
    repo_id: 1,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    agent_session_id: null,
    harness: "opencode",
    model: "anthropic/claude-haiku-4-5",
    reasoning_effort: null,
    status: "active",
    status_revision: 1,
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    vnc_enabled: 0,
    total_cost: 0,
    max_cost_usd: null,
    budget_exhausted: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1000,
    updated_at: 1000,
  };
  const participant: ParticipantRow = {
    id: client.participantId,
    user_id: client.userId,
    canonical_user_id: null,
    scm_user_id: null,
    scm_login: null,
    scm_email: null,
    scm_name: client.name,
    auth_name: null,
    role: "member",
    scm_access_token_encrypted: null,
    scm_refresh_token_encrypted: null,
    scm_token_expires_at: null,
    ws_auth_token: null,
    ws_token_created_at: null,
    joined_at: 1000,
  };
  const events: string[] = [];
  const messages: MessageRow[] = [];
  const log = {
    debug: vi.fn<Logger["debug"]>(),
    info: vi.fn<Logger["info"]>(),
    warn: vi.fn<Logger["warn"]>(),
    error: vi.fn<Logger["error"]>(),
    child: vi.fn<Logger["child"]>(),
  } satisfies Logger;
  const backgroundTasks = {
    submit: vi.fn<BackgroundTasks["submit"]>((task) => {
      void task();
    }),
  } satisfies BackgroundTasks;
  const repository = {
    getSession: vi.fn<SessionCoreRepository["getSession"]>(() => session),
  };
  const messageRepository = {
    getPendingOrProcessingCount: vi.fn<MessageRepository["getPendingOrProcessingCount"]>(
      () => messages.length
    ),
    getMessageByClientRequestId: vi.fn<MessageRepository["getMessageByClientRequestId"]>(
      (id) => messages.find((message) => message.client_request_id === id) ?? null
    ),
    getUnfinishedMessagePosition: vi.fn<MessageRepository["getUnfinishedMessagePosition"]>(() => 1),
    createMessageWithAttachments: vi.fn<MessageRepository["createMessageWithAttachments"]>(
      (data) => {
        events.push("insert");
        messages.push({
          id: data.id,
          author_id: data.authorId,
          author_canonical_user_id: data.authorCanonicalUserId ?? null,
          content: data.content,
          source: data.source,
          model: data.model ?? null,
          reasoning_effort: data.reasoningEffort ?? null,
          attachments: data.attachments ?? null,
          callback_context: data.callbackContext ?? null,
          client_request_id: data.clientRequestId ?? null,
          request_fingerprint: data.requestFingerprint ?? null,
          autofix_feedback_key: null,
          autofix_pr_key: null,
          origin_context: null,
          status: "pending",
          error_message: null,
          stop_confirmation_deadline: null,
          reported_cost_usd: 0,
          created_at: data.createdAt,
          started_at: null,
          completed_at: null,
        });
      }
    ),
    listPromptQueue: vi.fn<MessageRepository["listPromptQueue"]>(() => []),
  };
  const participantRepository = {
    getParticipantById: vi.fn<ParticipantRepository["getParticipantById"]>(() => participant),
    updateParticipantCoalesce: vi.fn<ParticipantRepository["updateParticipantCoalesce"]>(),
    updateParticipantIdentity: vi.fn<ParticipantRepository["updateParticipantIdentity"]>(),
  };
  const attachmentRepository = {
    getUnreferenced: vi.fn<SessionAttachmentRepository["getUnreferenced"]>(() => []),
  };
  const participantService = {
    getByUserId: vi.fn<ParticipantService["getByUserId"]>(() => participant),
    create: vi.fn<ParticipantService["create"]>(() => participant),
  };
  const sessionStatus = {
    transition: vi.fn<SessionStatusService["transition"]>(async () => {
      events.push("transition");
      return false;
    }),
  };
  const messenger = {
    sendToSandbox: vi.fn<SessionMessenger["sendToSandbox"]>(),
    broadcast: vi.fn<SessionMessenger["broadcast"]>(() => {
      events.push("broadcast");
    }),
  } satisfies SessionMessenger;
  const sessionIndex = {
    touchUpdatedAt: vi.fn<SessionIndexStore["touchUpdatedAt"]>(async () => {
      events.push("activity");
      return true;
    }),
  };
  const policy = {
    getProviderAuthenticationError: vi.fn<PromptPolicy["getProviderAuthenticationError"]>(
      async () => null
    ),
    getSandboxPromptBlockReason: vi.fn<PromptPolicy["getSandboxPromptBlockReason"]>(() => null),
  } satisfies PromptPolicy;
  const admission = new SessionPromptAdmission(
    backgroundTasks,
    log,
    repository as unknown as SessionCoreRepository,
    messageRepository as unknown as MessageRepository,
    participantRepository as unknown as ParticipantRepository,
    attachmentRepository as unknown as SessionAttachmentRepository,
    participantService as unknown as ParticipantService,
    sessionStatus as unknown as SessionStatusService,
    messenger,
    sessionIndex as unknown as SessionIndexStore,
    policy
  );
  return {
    admission,
    session,
    participant,
    events,
    messages,
    log,
    backgroundTasks,
    repository,
    messageRepository,
    participantRepository,
    attachmentRepository,
    participantService,
    sessionStatus,
    messenger,
    sessionIndex,
    policy,
  };
}

function expectNoMutation(h: ReturnType<typeof buildAdmission>) {
  expect(h.participantService.create).not.toHaveBeenCalled();
  expect(h.participantRepository.updateParticipantCoalesce).not.toHaveBeenCalled();
  expect(h.participantRepository.updateParticipantIdentity).not.toHaveBeenCalled();
  expect(h.messageRepository.createMessageWithAttachments).not.toHaveBeenCalled();
  expect(h.sessionStatus.transition).not.toHaveBeenCalled();
  expect(h.messenger.broadcast).not.toHaveBeenCalled();
  expect(h.backgroundTasks.submit).not.toHaveBeenCalled();
  expect(h.sessionIndex.touchUpdatedAt).not.toHaveBeenCalled();
}

describe("fingerprintWebPrompt", () => {
  it("canonicalizes omitted fields and attachment ids, not display names", async () => {
    const original = await fingerprintWebPrompt(client.participantId, prompt);
    expect(original).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      fingerprintWebPrompt(client.participantId, { ...prompt, attachments: [] })
    ).resolves.toBe(original);
    const attached = await fingerprintWebPrompt(client.participantId, {
      ...prompt,
      attachments: [{ name: "first.png", attachmentId: "up-1" }],
    });
    await expect(
      fingerprintWebPrompt(client.participantId, {
        ...prompt,
        attachments: [{ name: "renamed.png", attachmentId: "up-1" }],
      })
    ).resolves.toBe(attached);
    expect(attached).not.toBe(original);
    await expect(fingerprintWebPrompt("other-participant", prompt)).resolves.not.toBe(original);
    await expect(
      fingerprintWebPrompt(client.participantId, { ...prompt, model: "other-model" })
    ).resolves.not.toBe(original);
    await expect(
      fingerprintWebPrompt(client.participantId, { ...prompt, reasoningEffort: "high" })
    ).resolves.not.toBe(original);
  });
});

describe.each(["web", "api"] as const)("%s admission", (source) => {
  function enqueue(h: ReturnType<typeof buildAdmission>, data = prompt) {
    return source === "web"
      ? h.admission.enqueueFromWeb(client, data)
      : h.admission.enqueueFromApi({ ...data, authorId: client.userId, source: "agent" });
  }

  it("awaits status projection before broadcasting, then touches activity before returning", async () => {
    const h = buildAdmission();
    const transition = deferred<boolean>();
    const entered = deferred<void>();
    h.sessionStatus.transition.mockImplementation(() => {
      h.events.push("transition");
      entered.resolve();
      return transition.promise;
    });
    const queued = enqueue(h).then((result) => {
      h.events.push("return");
      return result;
    });
    await entered.promise;
    expect(h.events).toEqual(["insert", "transition"]);
    expect(h.sessionStatus.transition).toHaveBeenCalledWith("active");
    transition.resolve(false);
    const result = await queued;

    expect(result).toEqual({ messageId: h.messages[0].id, position: 1, deduplicated: false });
    expect(h.events).toEqual(["insert", "transition", "broadcast", "activity", "return"]);
    expect(h.messenger.broadcast).toHaveBeenCalledWith({
      type: "prompt_queue_updated",
      promptQueue: h.messageRepository.listPromptQueue(),
    });
    expect(h.backgroundTasks.submit).toHaveBeenCalledWith(expect.any(Function), {
      name: "session_index.touch_updated_at",
      context: { session_id: "s1" },
    });
    expect(h.sessionIndex.touchUpdatedAt).toHaveBeenCalledWith("s1");
    expect(h.messages[0]).toMatchObject({
      author_id: client.participantId,
      content: prompt.content,
      source: source === "web" ? "web" : "agent",
      status: "pending",
      client_request_id: prompt.clientRequestId,
      request_fingerprint: await fingerprintWebPrompt(client.participantId, prompt),
    });
    expect(h.policy.getProviderAuthenticationError).not.toHaveBeenCalled();
  });

  it("touches activity for duplicates without reinserting, transitioning or broadcasting", async () => {
    const h = buildAdmission();
    const first = await enqueue(h);
    h.session.budget_exhausted = 1;
    h.messageRepository.getPendingOrProcessingCount.mockReturnValue(MAX_UNFINISHED_PROMPTS);
    h.messageRepository.getUnfinishedMessagePosition.mockReturnValue(null);
    h.events.length = 0;

    await expect(enqueue(h)).resolves.toEqual({ ...first, position: null, deduplicated: true });
    expect(h.events).toEqual(["activity"]);
    expect(h.messageRepository.createMessageWithAttachments).toHaveBeenCalledOnce();
    expect(h.sessionStatus.transition).toHaveBeenCalledOnce();
    expect(h.messenger.broadcast).toHaveBeenCalledOnce();
    expect(h.sessionIndex.touchUpdatedAt).toHaveBeenCalledTimes(2);
  });

  it("rejects a conflicting request id without further activity", async () => {
    const h = buildAdmission();
    await enqueue(h);
    h.events.length = 0;
    await expect(enqueue(h, { ...prompt, content: "Different" })).rejects.toBeInstanceOf(
      PromptRequestConflictError
    );
    expect(h.events).toEqual([]);
    expect(h.messageRepository.createMessageWithAttachments).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "archived"] as const)(
    "rejects a %s session before participant preparation",
    async (status) => {
      const h = buildAdmission();
      h.session.status = status;
      await expect(enqueue(h)).rejects.toMatchObject({
        name: "SessionNotPromptableError",
        sessionStatus: status,
      });
      expect(h.participantRepository.getParticipantById).not.toHaveBeenCalled();
      expect(h.participantService.getByUserId).not.toHaveBeenCalled();
      expectNoMutation(h);
    }
  );

  it("rejects a live sandbox policy failure before participant preparation", async () => {
    const h = buildAdmission();
    h.policy.getSandboxPromptBlockReason.mockReturnValue("Recovery required");
    await expect(enqueue(h)).rejects.toBeInstanceOf(SandboxPromptBlockedError);
    expect(h.participantRepository.getParticipantById).not.toHaveBeenCalled();
    expect(h.participantService.getByUserId).not.toHaveBeenCalled();
    expectNoMutation(h);
  });

  it.each(["budget", "capacity"] as const)(
    "checks %s before creating a missing participant",
    async (guard) => {
      const h = buildAdmission();
      h.participantRepository.getParticipantById.mockReturnValue(null);
      h.participantService.getByUserId.mockReturnValue(null);
      h.messageRepository.getPendingOrProcessingCount.mockReturnValue(MAX_UNFINISHED_PROMPTS);
      if (guard === "budget") h.session.budget_exhausted = 1;
      await expect(enqueue(h)).rejects.toBeInstanceOf(
        guard === "budget" ? BudgetExhaustedError : PromptQueueFullError
      );
      if (guard === "budget") {
        expect(h.messageRepository.getPendingOrProcessingCount).not.toHaveBeenCalled();
      }
      expectNoMutation(h);
    }
  );

  describe.each(["fingerprint", "auth"] as const)("after awaiting %s", (boundary) => {
    it.each(["status", "sandbox", "budget", "capacity"] as const)(
      "rechecks the live %s guard without admitting work",
      async (guard) => {
        const h = buildAdmission();
        const auth = deferred<string | null>();
        const entered = deferred<void>();
        if (boundary === "auth") {
          h.session.harness = "codex";
          h.session.model = "openai/gpt-6.1-sol";
          h.policy.getProviderAuthenticationError.mockImplementation(() => {
            entered.resolve();
            return auth.promise;
          });
        }
        const queued = enqueue(h);
        if (boundary === "auth") await entered.promise;
        const error = {
          status: SessionNotPromptableError,
          sandbox: SandboxPromptBlockedError,
          budget: BudgetExhaustedError,
          capacity: PromptQueueFullError,
        }[guard];
        if (guard === "status") h.session.status = "cancelled";
        if (guard === "sandbox") {
          h.policy.getSandboxPromptBlockReason.mockReturnValue("Recovery required");
        }
        if (guard === "budget") h.session.budget_exhausted = 1;
        if (guard === "capacity") {
          h.messageRepository.getPendingOrProcessingCount.mockReturnValue(MAX_UNFINISHED_PROMPTS);
        }
        auth.resolve(null);
        await expect(queued).rejects.toBeInstanceOf(error);
        expectNoMutation(h);
      }
    );
  });

  it("does not mutate admission state when strict auth rejects an existing participant", async () => {
    const h = buildAdmission();
    h.session.harness = "codex";
    h.session.model = "openai/gpt-6.1-sol";
    h.policy.getProviderAuthenticationError.mockResolvedValue("Model disabled");
    await expect(enqueue(h)).rejects.toBeInstanceOf(HarnessModelIncompatibleError);
    expect(h.policy.getProviderAuthenticationError).toHaveBeenCalledWith(h.session.model);
    expect(h.attachmentRepository.getUnreferenced).not.toHaveBeenCalled();
    expectNoMutation(h);
  });

  it("deduplicates concurrent strict-auth requests after the policy await", async () => {
    const h = buildAdmission();
    h.session.harness = "codex";
    h.session.model = "openai/gpt-6.1-sol";
    const auth = deferred<string | null>();
    const bothEntered = deferred<void>();
    let authCalls = 0;
    h.policy.getProviderAuthenticationError.mockImplementation(() => {
      if (++authCalls === 2) bothEntered.resolve();
      return auth.promise;
    });
    const first = enqueue(h);
    const second = enqueue(h);
    await bothEntered.promise;
    expectNoMutation(h);
    auth.resolve(null);
    const results = await Promise.all([first, second]);
    expect(results[0].messageId).toBe(results[1].messageId);
    expect(results.map((result) => result.deduplicated).sort()).toEqual([false, true]);
    expect(h.messageRepository.createMessageWithAttachments).toHaveBeenCalledOnce();
    expect(h.sessionStatus.transition).toHaveBeenCalledOnce();
    expect(h.messenger.broadcast).toHaveBeenCalledOnce();
    expect(h.sessionIndex.touchUpdatedAt).toHaveBeenCalledTimes(2);

    h.policy.getProviderAuthenticationError.mockResolvedValue("Model disabled now");
    await expect(enqueue(h)).resolves.toEqual({ ...results[0], deduplicated: true });
    expect(h.policy.getProviderAuthenticationError).toHaveBeenCalledTimes(2);
    expect(h.sessionIndex.touchUpdatedAt).toHaveBeenCalledTimes(3);
  });
});

describe("participant preparation and validation", () => {
  it.each(["opencode", "codex"] as const)(
    "does not enrich a duplicate or conflicting API retry on %s",
    async (harness) => {
      const h = buildAdmission();
      h.session.harness = harness;
      h.session.model = "openai/gpt-6.1-sol";
      const request = {
        ...prompt,
        authorId: client.userId,
        source: "github" as const,
        canonicalUserId: "old-user",
        scmEnrichment: { userId: "1001", login: "old-login", name: "Old Name", email: null },
      };
      const first = await h.admission.enqueueFromApi(request);
      h.participant.canonical_user_id = "current-user";
      h.participant.scm_login = "current-login";
      h.participantRepository.updateParticipantCoalesce.mockClear();
      h.participantRepository.updateParticipantIdentity.mockClear();

      await expect(h.admission.enqueueFromApi(request)).resolves.toEqual({
        ...first,
        deduplicated: true,
      });
      await expect(
        h.admission.enqueueFromApi({ ...request, content: "Different content" })
      ).rejects.toBeInstanceOf(PromptRequestConflictError);

      expect(h.participantRepository.updateParticipantCoalesce).not.toHaveBeenCalled();
      expect(h.participantRepository.updateParticipantIdentity).not.toHaveBeenCalled();
      expect(h.messageRepository.createMessageWithAttachments).toHaveBeenCalledOnce();
      expect(h.sessionIndex.touchUpdatedAt).toHaveBeenCalledTimes(2);
    }
  );

  it("does not enrich a request deduplicated after the strict-auth await", async () => {
    const h = buildAdmission();
    h.session.harness = "codex";
    h.session.model = "openai/gpt-6.1-sol";
    const auth = deferred<string | null>();
    const entered = deferred<void>();
    h.policy.getProviderAuthenticationError.mockImplementationOnce(() => {
      entered.resolve();
      return auth.promise;
    });
    const request = {
      ...prompt,
      authorId: client.userId,
      source: "github" as const,
      canonicalUserId: "old-user",
      scmEnrichment: { userId: "1001", login: "old-login", name: "Old Name", email: null },
    };
    const delayed = h.admission.enqueueFromApi(request);
    await entered.promise;
    expect(h.participantRepository.updateParticipantCoalesce).not.toHaveBeenCalled();
    expect(h.participantRepository.updateParticipantIdentity).not.toHaveBeenCalled();
    const first = await h.admission.enqueueFromApi({
      ...request,
      canonicalUserId: "current-user",
      scmEnrichment: { ...request.scmEnrichment, login: "current-login" },
    });
    auth.resolve(null);
    await expect(delayed).resolves.toEqual({ ...first, deduplicated: true });

    expect(h.participantRepository.updateParticipantCoalesce).toHaveBeenCalledExactlyOnceWith(
      client.participantId,
      { canonicalUserId: "current-user" }
    );
    expect(h.participantRepository.updateParticipantIdentity).toHaveBeenCalledExactlyOnceWith(
      client.participantId,
      expect.objectContaining({ canonicalUserId: "current-user", scmLogin: "current-login" })
    );
    expect(h.messageRepository.createMessageWithAttachments).toHaveBeenCalledOnce();
  });

  it("prefers the web participant id, then falls back to user lookup and creation", async () => {
    const h = buildAdmission();
    await h.admission.enqueueFromWeb(client, { content: "First" });
    expect(h.participantRepository.getParticipantById).toHaveBeenCalledWith(client.participantId);
    expect(h.participantService.getByUserId).not.toHaveBeenCalled();
    h.participantRepository.getParticipantById.mockReturnValue(null);
    await h.admission.enqueueFromWeb(client, { content: "Second" });
    expect(h.participantService.getByUserId).toHaveBeenCalledWith(client.userId);
    expect(h.participantService.create).not.toHaveBeenCalled();
    h.participantService.getByUserId.mockReturnValue(null);
    await h.admission.enqueueFromWeb(client, { content: "Third" });
    expect(h.participantService.create).toHaveBeenCalledWith(client.userId, client.name);
  });

  it("prepares canonical API identity and authoritative SCM enrichment before insertion", async () => {
    const h = buildAdmission();
    h.participantService.getByUserId.mockReturnValue(null);
    h.participantRepository.getParticipantById.mockReturnValue(null);
    await h.admission.enqueueFromApi({
      content: "Fix bug",
      authorId: "github:1001",
      source: "github",
      canonicalUserId: "canonical-1",
      scmEnrichment: { userId: "1001", login: "octocat", name: "Octo Cat", email: null },
      callbackContext: { thread: "thread-1" },
    });
    expect(h.participantService.create).toHaveBeenCalledWith(
      "github:1001",
      "Octo Cat",
      "canonical-1"
    );
    expect(h.participantRepository.updateParticipantCoalesce).toHaveBeenCalledWith("part-1", {
      canonicalUserId: "canonical-1",
    });
    expect(h.participantRepository.updateParticipantIdentity).toHaveBeenCalledWith("part-1", {
      canonicalUserId: "canonical-1",
      scmUserId: "1001",
      scmLogin: "octocat",
      scmName: "Octo Cat",
      scmEmail: null,
    });
    expect(h.messages[0]).toMatchObject({
      source: "github",
      callback_context: JSON.stringify({ thread: "thread-1" }),
    });
    expect(
      h.participantRepository.updateParticipantIdentity.mock.invocationCallOrder[0]
    ).toBeLessThan(h.messageRepository.createMessageWithAttachments.mock.invocationCallOrder[0]);
  });

  it.each([
    { label: "no account", stored: null, scmEnrichment: undefined },
    {
      label: "no account and SCM enrichment",
      stored: null,
      scmEnrichment: { userId: "1001", login: "octocat", name: null, email: null },
    },
    { label: "a previous account", stored: "previous-account", scmEnrichment: undefined },
  ])(
    "records the account an API prompt gives a participant with $label",
    async ({ stored, scmEnrichment }) => {
      const h = buildAdmission();
      h.participant.canonical_user_id = stored;
      await h.admission.enqueueFromApi({
        content: "Fix",
        authorId: client.userId,
        source: "slack",
        canonicalUserId: "canonical-1",
        scmEnrichment,
      });
      expect(h.messages[0].author_canonical_user_id).toBe("canonical-1");
    }
  );

  it("records the participant's stored account when the prompt names none", async () => {
    const h = buildAdmission();
    h.participant.canonical_user_id = "canonical-1";
    await h.admission.enqueueFromWeb(client, { content: "Web" });
    await h.admission.enqueueFromApi({ content: "Api", authorId: client.userId, source: "slack" });
    expect(h.messages.map((message) => message.author_canonical_user_id)).toEqual([
      "canonical-1",
      "canonical-1",
    ]);
  });

  it.each(["parent-account", null])(
    "records a relayed prompt's account %s in place of its author's",
    async (promptAccountUserId) => {
      const h = buildAdmission();
      await h.admission.enqueueFromApi({
        content: "Follow up",
        authorId: client.userId,
        source: "agent",
        canonicalUserId: "canonical-1",
        promptAccountUserId,
      });
      expect(h.participantRepository.updateParticipantCoalesce).toHaveBeenCalledWith("part-1", {
        canonicalUserId: "canonical-1",
      });
      expect(h.messages[0].author_canonical_user_id).toBe(promptAccountUserId);
    }
  );

  it("falls back to the API author id without changing absent SCM enrichment", async () => {
    const h = buildAdmission();
    h.participantService.getByUserId.mockReturnValue(null);
    await h.admission.enqueueFromApi({ content: "Fix", authorId: "bot-1", source: "agent" });
    expect(h.participantService.create).toHaveBeenCalledWith("bot-1", "bot-1");
    expect(h.participantRepository.updateParticipantCoalesce).not.toHaveBeenCalled();
    expect(h.participantRepository.updateParticipantIdentity).not.toHaveBeenCalled();
  });

  it("resolves attachments and passes claims to the atomic repository operation", async () => {
    const h = buildAdmission();
    h.attachmentRepository.getUnreferenced.mockReturnValue([
      {
        id: "up-1",
        mime_type: "image/png",
        size_bytes: 10,
        object_key: "attachments/up-1",
        message_id: null,
        cleanup_claimed_at: null,
        created_at: 1000,
      },
    ]);
    await h.admission.enqueueFromWeb(client, {
      content: "Inspect",
      attachments: [{ attachmentId: "up-1", name: "image.png" }],
    });
    expect(h.attachmentRepository.getUnreferenced).toHaveBeenCalledWith(["up-1"]);
    expect(h.messageRepository.createMessageWithAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: JSON.stringify([
          { name: "image.png", attachmentId: "up-1", mimeType: "image/png" },
        ]),
      }),
      ["up-1"]
    );
  });

  it("rejects unresolved attachments before any admission mutation", async () => {
    const h = buildAdmission();
    await expect(
      h.admission.enqueueFromWeb(client, {
        content: "Inspect",
        attachments: [{ attachmentId: "missing", name: "image.png" }],
      })
    ).rejects.toBeInstanceOf(SessionAttachmentError);
    expectNoMutation(h);
  });

  it("translates atomic attachment claim conflicts without status or activity side effects", async () => {
    const h = buildAdmission();
    h.messageRepository.createMessageWithAttachments.mockImplementation(() => {
      throw new AttachmentClaimConflictError();
    });
    await expect(h.admission.enqueueFromWeb(client, prompt)).rejects.toThrow(
      "One or more attachments are missing, expired, or already used"
    );
    expect(h.sessionStatus.transition).not.toHaveBeenCalled();
    expect(h.messenger.broadcast).not.toHaveBeenCalled();
    expect(h.backgroundTasks.submit).not.toHaveBeenCalled();
  });

  it("ignores invalid permissive model and reasoning overrides", async () => {
    const h = buildAdmission();
    await h.admission.enqueueFromWeb(client, {
      content: "Continue",
      model: "invalid-model",
      reasoningEffort: "invalid-effort",
    });
    expect(h.messages[0]).toMatchObject({ model: null, reasoning_effort: null });
    expect(h.log.warn).toHaveBeenCalledWith("Invalid message model, ignoring override", {
      model: "invalid-model",
    });
    expect(h.log.warn).toHaveBeenCalledWith("Invalid reasoning effort for model, ignoring", {
      model: h.session.model,
      reasoning_effort: "invalid-effort",
    });
  });

  it("preserves strict overrides for compatibility rejection even when auth passes", async () => {
    const h = buildAdmission();
    h.session.harness = "codex";
    h.session.model = "openai/gpt-6.1-sol";
    await expect(
      h.admission.enqueueFromWeb(client, { content: "Continue", model: "invalid-model" })
    ).rejects.toBeInstanceOf(HarnessModelIncompatibleError);
    expect(h.policy.getProviderAuthenticationError).toHaveBeenCalledWith("invalid-model");
    expectNoMutation(h);
  });

  it("touches the internal session id when no public name is available", async () => {
    const h = buildAdmission();
    h.session.session_name = null;
    await h.admission.enqueueFromWeb(client, { content: "Continue" });
    expect(h.sessionIndex.touchUpdatedAt).toHaveBeenCalledWith(h.session.id);
  });
});
