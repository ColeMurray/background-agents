import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentSessionEvent } from "./webhook-handler";
import type { AgentSessionWebhook } from "./types";
import {
  createFakeKV,
  createLinearFetchMock,
  linearClientCredentialsResponse,
  linearIdentityResponse,
  linearUserResponse,
  makeLinearBotEnv,
} from "./test-helpers";

const TOKEN_TTL_MS = 60 * 60 * 1000;
const AUTHOR = { id: "returning-user", name: "Ada Lovelace", email: "ada@example.com" };
type Interaction = "follow_up" | "stop";
type FailedOutcome = "email_required" | "unavailable";

const FAILURE_COPY: Record<Interaction, Record<FailedOutcome, string>> = {
  follow_up: {
    email_required:
      "Cannot process this follow-up because your Linear email could not be read to link your account.",
    unavailable:
      "Cannot process this follow-up because your Linear account could not be verified. Try again.",
  },
  stop: {
    email_required:
      "Cannot stop this session because your Linear email could not be read to link your account.",
    unavailable:
      "Cannot stop this session because your Linear account could not be verified. Try again.",
  },
};

interface ControlPlaneRequest {
  method: string;
  path: string;
  actor: string | null;
  body: string | undefined;
}

function validToken(): string {
  const issuedAt = Date.now();
  return JSON.stringify({
    version: 1,
    access_token: "valid-token",
    token_type: "Bearer",
    scope: "read,write,app:assignable,app:mentionable",
    issued_at: issuedAt,
    expires_at: issuedAt + TOKEN_TTL_MS,
    organization_id: "org-1",
    organization_name: "Acme",
    app_user_id: "app-user-1",
  });
}

function makeWebhook(interaction: Interaction): AgentSessionWebhook {
  return {
    type: "AgentSessionEvent",
    action: "prompted",
    organizationId: "org-1",
    webhookId: "webhook-prompted",
    appUserId: "app-user-1",
    agentSession: {
      id: "agent-session-1",
      creatorId: "session-starter",
      issue: {
        id: "issue-1",
        identifier: "ENG-42",
        title: "Fix the flow",
        description: "Details.",
        url: "https://linear.app/acme/issue/ENG-42/fix",
        priority: 0,
        priorityLabel: "No priority",
        team: { id: "team-1", key: "ENG", name: "Engineering" },
        labels: [],
      },
    },
    agentActivity:
      interaction === "stop"
        ? { userId: AUTHOR.id, signal: "stop", content: { type: "prompt", body: "stop" } }
        : { userId: AUTHOR.id, content: { type: "prompt", body: "Please continue." } },
  };
}

/**
 * Deliver a follow-up or stop from a user acting on a session someone else
 * started, recording every control-plane request and every Linear activity.
 */
async function interact(
  interaction: Interaction,
  options: {
    enrollResponse?: () => Promise<Response>;
    userLookup?: () => Response;
  } = {}
) {
  const { kv, store } = createFakeKV({
    "oauth:client-credentials:org-1": validToken(),
    "issue:issue-1": JSON.stringify({
      sessionId: "session-xyz",
      issueId: "issue-1",
      issueIdentifier: "ENG-42",
      linearTeamId: "team-1",
      repoOwner: "acme",
      repoName: "backend",
      model: "anthropic/claude-haiku-4-5",
      createdAt: Date.now(),
    }),
  });
  const linearFetch = createLinearFetchMock({
    clientCredentials: () => linearClientCredentialsResponse("runtime-token"),
    identity: () => linearIdentityResponse(),
    user: options.userLookup ?? (() => linearUserResponse(AUTHOR)),
    graphql: () => Response.json({ data: {} }),
  });
  vi.stubGlobal("fetch", linearFetch);

  const env = makeLinearBotEnv(kv);
  const requests: ControlPlaneRequest[] = [];
  const controlPlaneFetch = (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> })
    .fetch;
  controlPlaneFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      actor: new Headers(init?.headers).get("X-OpenInspect-Actor"),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url.pathname === "/actors/me") {
      return options.enrollResponse
        ? options.enrollResponse()
        : new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/integration-settings/linear/resolved/")) {
      return Response.json({ config: null });
    }
    if (url.pathname === "/sessions/session-xyz/events") return Response.json({ events: [] });
    if (url.pathname === "/sessions/session-xyz/prompt") return Response.json({ ok: true });
    if (url.pathname === "/sessions/session-xyz/stop") {
      return Response.json({ status: "stopping" });
    }
    throw new Error(`Unexpected control-plane fetch to ${url}`);
  });

  await handleAgentSessionEvent(makeWebhook(interaction), env, "trace-enroll");

  const activities = linearFetch.mock.calls.flatMap(([, init]) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as {
      query?: string;
      variables?: { input?: { content?: { type: string; body: string } } };
    };
    const content = request.variables?.input?.content;
    return request.query?.includes("agentActivityCreate") && content ? [content] : [];
  });

  return {
    actorRequests: requests.filter((request) => request.actor !== null),
    activities,
    sessionMappingRetained: store.has("issue:issue-1"),
  };
}

const PAYLOAD_PATHS: Record<Interaction, string[]> = {
  follow_up: ["/sessions/session-xyz/events", "/sessions/session-xyz/prompt"],
  stop: ["/sessions/session-xyz/stop"],
};

const FAILED_ENROLLMENTS: Array<[string, () => Promise<Response>, FailedOutcome]> = [
  [
    "email_required",
    async () => Response.json({ code: "actor_email_required" }, { status: 403 }),
    "email_required",
  ],
  ["a non-OK response", async () => new Response(null, { status: 503 }), "unavailable"],
  [
    "a timeout",
    () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    "unavailable",
  ],
];

describe("Linear actor enrollment before acting on an existing session", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each<Interaction>(["follow_up", "stop"])(
    "enrolls a %s author with their Linear profile before any request carrying them",
    async (interaction) => {
      const { actorRequests } = await interact(interaction);

      expect(actorRequests.map(({ path }) => path)).toEqual([
        "/actors/me",
        ...PAYLOAD_PATHS[interaction],
      ]);
      expect(actorRequests.every(({ actor }) => actor === `linear:${AUTHOR.id}`)).toBe(true);
      expect(actorRequests[0]?.method).toBe("POST");
      expect(JSON.parse(String(actorRequests[0]?.body))).toEqual({
        displayName: AUTHOR.name,
        email: AUTHOR.email,
      });
    }
  );

  it.each(FAILED_ENROLLMENTS)(
    "sends no follow-up and explains why when enrollment fails with %s",
    async (_label, enrollResponse, outcome) => {
      const { actorRequests, activities } = await interact("follow_up", { enrollResponse });

      expect(actorRequests.map(({ path }) => path)).toEqual(["/actors/me"]);
      expect(activities).toContainEqual({ type: "error", body: FAILURE_COPY.follow_up[outcome] });
      expect(activities.map(({ body }) => body)).not.toContain(
        "Follow-up sent to existing session."
      );
    }
  );

  it.each(FAILED_ENROLLMENTS)(
    "sends no stop, keeps the session mapping, and explains why when enrollment fails with %s",
    async (_label, enrollResponse, outcome) => {
      const { actorRequests, activities, sessionMappingRetained } = await interact("stop", {
        enrollResponse,
      });

      expect(actorRequests.map(({ path }) => path)).toEqual(["/actors/me"]);
      expect(sessionMappingRetained).toBe(true);
      expect(activities).toContainEqual({ type: "error", body: FAILURE_COPY.stop[outcome] });
    }
  );

  it.each<Interaction>(["follow_up", "stop"])(
    "enrolls a %s author without an email when Linear returns none",
    async (interaction) => {
      const { actorRequests } = await interact(interaction, {
        userLookup: () => linearUserResponse({ ...AUTHOR, email: null }),
      });

      expect(actorRequests.map(({ path }) => path)).toEqual([
        "/actors/me",
        ...PAYLOAD_PATHS[interaction],
      ]);
      expect(JSON.parse(String(actorRequests[0]?.body))).toEqual({ displayName: AUTHOR.name });
    }
  );

  it("sends no follow-up request carrying the author when the Linear user lookup fails", async () => {
    const { actorRequests, activities } = await interact("follow_up", {
      userLookup: () => new Response("unavailable", { status: 503 }),
    });

    expect(actorRequests).toEqual([]);
    expect(activities).toContainEqual({ type: "error", body: FAILURE_COPY.follow_up.unavailable });
  });

  it("sends no stop, keeps the session mapping, and explains why when the Linear user lookup fails", async () => {
    const { actorRequests, activities, sessionMappingRetained } = await interact("stop", {
      userLookup: () => new Response("unavailable", { status: 503 }),
    });

    expect(actorRequests).toEqual([]);
    expect(sessionMappingRetained).toBe(true);
    expect(activities).toContainEqual({ type: "error", body: FAILURE_COPY.stop.unavailable });
  });
});
