import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTOR_EMAIL_REQUIRED_CODE } from "@open-inspect/shared/types/actors";
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

const AUTHOR = { id: "returning-user", name: "Ada Lovelace", email: "ada@example.com" };
type Interaction = "follow_up" | "stop";
type FailedOutcome = "email_required" | "admission_denied" | "unavailable";

const FAILURE_COPY: Record<FailedOutcome, string> = {
  email_required:
    "Cannot link your Linear account because its email is unavailable. Ask an administrator to check that the bot can read your Linear email.",
  admission_denied:
    "Your account is not authorized to join this Open-Inspect workspace. Sign in on the web with your Linear email, or ask an administrator to check the admission allowlists.",
  unavailable:
    "Cannot verify your Open-Inspect account right now. Please retry or ask an administrator to check your workspace access.",
};

interface ControlPlaneRequest {
  method: string;
  path: string;
  search: string;
  actor: string | null;
  body: string | undefined;
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
 * started, recording API ordering, Linear activities, and mapping deletion.
 */
async function interact(
  interaction: Interaction,
  options: {
    initialEnrollResponse?: () => Promise<Response>;
    enrollResponse?: () => Promise<Response>;
    userLookup?: () => Response;
    firstStopResponse?: () => Response;
    retryStopResponse?: () => Response;
    clientCredentials?: () => Response;
  } = {}
) {
  const { kv, store } = createFakeKV({
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
  const sequence: string[] = [];
  vi.mocked(kv.delete).mockImplementation(async (key) => {
    if (key === "issue:issue-1") sequence.push(`delete:${key}`);
    store.delete(key);
  });
  const linearFetch = createLinearFetchMock({
    clientCredentials: () => {
      sequence.push("linear:credentials");
      return options.clientCredentials?.() ?? linearClientCredentialsResponse("runtime-token");
    },
    identity: () => {
      sequence.push("linear:identity");
      return linearIdentityResponse();
    },
    user: ({ body }) => {
      sequence.push("linear:profile");
      expect(body.variables).toEqual({ id: AUTHOR.id });
      return options.userLookup?.() ?? linearUserResponse(AUTHOR);
    },
    graphql: () => Response.json({ data: {} }),
  });
  vi.stubGlobal("fetch", linearFetch);

  const env = makeLinearBotEnv(kv);
  const requests: ControlPlaneRequest[] = [];
  const controlPlaneFetch = (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> })
    .fetch;
  controlPlaneFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    sequence.push(url.pathname);
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      search: url.search,
      actor: new Headers(init?.headers).get("X-OpenInspect-Actor"),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url.pathname === "/actors/me") {
      const enrollCount = requests.filter(({ path }) => path === url.pathname).length;
      if (enrollCount === 1) {
        return (
          options.initialEnrollResponse?.() ??
          Response.json({ code: ACTOR_EMAIL_REQUIRED_CODE }, { status: 403 })
        );
      }
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
      const stopCount = requests.filter(({ path }) => path === url.pathname).length;
      if (stopCount === 1) {
        return (
          options.firstStopResponse?.() ??
          Response.json({ code: ACTOR_EMAIL_REQUIRED_CODE }, { status: 403 })
        );
      }
      return options.retryStopResponse?.() ?? Response.json({ status: "stopping" });
    }
    throw new Error(`Unexpected control-plane fetch to ${url}`);
  });

  await handleAgentSessionEvent(makeWebhook(interaction), env, "trace-enroll");

  const activities = linearFetch.mock.calls
    .filter(([input]) => String(input) === "https://api.linear.app/graphql")
    .flatMap(([, init]) => {
      const request = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: { input?: { content?: { type: string; body: string } } };
      };
      const content = request.variables?.input?.content;
      return request.query?.includes("agentActivityCreate") && content ? [content] : [];
    });

  return {
    actorRequests: requests.filter((request) => request.actor !== null),
    sequence,
    activities,
    sessionMappingRetained: store.has("issue:issue-1"),
    mappingDeleteCount: vi.mocked(kv.delete).mock.calls.filter(([key]) => key === "issue:issue-1")
      .length,
  };
}

const ENROLLMENT_PATHS: Record<Interaction, string[]> = {
  follow_up: ["/actors/me", "/actors/me"],
  stop: ["/sessions/session-xyz/stop", "/actors/me", "/actors/me"],
};

const SUCCESS_PATHS: Record<Interaction, string[]> = {
  follow_up: [
    "/actors/me",
    "/actors/me",
    "/sessions/session-xyz/events",
    "/sessions/session-xyz/prompt",
  ],
  stop: ["/sessions/session-xyz/stop", "/actors/me", "/actors/me", "/sessions/session-xyz/stop"],
};

const FAILED_ENROLLMENTS: Array<[string, () => Promise<Response>, FailedOutcome]> = [
  [
    "email_required",
    async () => Response.json({ code: ACTOR_EMAIL_REQUIRED_CODE }, { status: 403 }),
    "email_required",
  ],
  ["a non-OK response", async () => new Response(null, { status: 503 }), "unavailable"],
  [
    "admission_denied",
    async () => Response.json({ code: "actor_admission_denied" }, { status: 403 }),
    "admission_denied",
  ],
  [
    "a timeout",
    () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    "unavailable",
  ],
];

describe("Linear actor enrollment for existing-session interactions", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("probes before fetching the follow-up author's profile and enrolls before resolving settings, reading events, or prompting", async () => {
    const { actorRequests, sequence, sessionMappingRetained, mappingDeleteCount } =
      await interact("follow_up");

    expect(sequence).toEqual([
      "linear:credentials",
      "linear:identity",
      "/actors/me",
      "linear:profile",
      "/actors/me",
      "/integration-settings/linear/resolved/acme/backend",
      "/sessions/session-xyz/events",
      "/sessions/session-xyz/prompt",
    ]);
    expect(actorRequests.map(({ path }) => path)).toEqual(SUCCESS_PATHS.follow_up);
    expect(actorRequests.every(({ actor }) => actor === `linear:${AUTHOR.id}`)).toBe(true);
    expect(actorRequests[0]?.method).toBe("POST");
    expect(JSON.parse(String(actorRequests[0]?.body))).toEqual({});
    expect(actorRequests[1]?.method).toBe("POST");
    expect(JSON.parse(String(actorRequests[1]?.body))).toEqual({
      displayName: AUTHOR.name,
      email: AUTHOR.email,
    });
    expect(sessionMappingRetained).toBe(true);
    expect(mappingDeleteCount).toBe(0);
  });

  it("requests a stop before acquiring Linear credentials and deletes the mapping only after enrollment and retry", async () => {
    const { actorRequests, sequence, sessionMappingRetained, mappingDeleteCount } =
      await interact("stop");

    expect(sequence).toEqual([
      "/sessions/session-xyz/stop",
      "linear:credentials",
      "linear:identity",
      "/actors/me",
      "linear:profile",
      "/actors/me",
      "/sessions/session-xyz/stop",
      "delete:issue:issue-1",
    ]);
    expect(actorRequests.map(({ path }) => path)).toEqual(SUCCESS_PATHS.stop);
    expect(actorRequests.every(({ actor }) => actor === `linear:${AUTHOR.id}`)).toBe(true);
    expect(actorRequests[0]).toEqual({
      method: "POST",
      path: "/sessions/session-xyz/stop",
      search: "?channel=linear%3Ateam-1",
      actor: `linear:${AUTHOR.id}`,
      body: undefined,
    });
    expect(actorRequests[3]).toEqual(actorRequests[0]);
    expect(JSON.parse(String(actorRequests[1]?.body))).toEqual({});
    expect(JSON.parse(String(actorRequests[2]?.body))).toEqual({
      displayName: AUTHOR.name,
      email: AUTHOR.email,
    });
    expect(sessionMappingRetained).toBe(false);
    expect(mappingDeleteCount).toBe(1);
  });

  describe.each<Interaction>(["follow_up", "stop"])("%s enrollment failure", (interaction) => {
    it.each(FAILED_ENROLLMENTS)(
      "does not act further or delete the mapping when enrollment fails with %s",
      async (_label, enrollResponse, outcome) => {
        const { actorRequests, activities, sessionMappingRetained, mappingDeleteCount } =
          await interact(interaction, { enrollResponse });

        expect(actorRequests.map(({ path }) => path)).toEqual(ENROLLMENT_PATHS[interaction]);
        expect(sessionMappingRetained).toBe(true);
        expect(mappingDeleteCount).toBe(0);
        expect(activities).toEqual([{ type: "error", body: FAILURE_COPY[outcome] }]);
      }
    );
  });

  it.each<Interaction>(["follow_up", "stop"])(
    "lets the control plane refuse an unknown email-less %s author without acting further",
    async (interaction) => {
      const { actorRequests, activities, sessionMappingRetained, mappingDeleteCount } =
        await interact(interaction, {
          userLookup: () => linearUserResponse({ ...AUTHOR, email: null }),
          enrollResponse: async () =>
            Response.json({ code: ACTOR_EMAIL_REQUIRED_CODE }, { status: 403 }),
        });

      expect(actorRequests.map(({ path }) => path)).toEqual(ENROLLMENT_PATHS[interaction]);
      expect(JSON.parse(String(actorRequests.at(-1)?.body))).toEqual({ displayName: AUTHOR.name });
      expect(activities).toEqual([{ type: "error", body: FAILURE_COPY.email_required }]);
      expect(sessionMappingRetained).toBe(true);
      expect(mappingDeleteCount).toBe(0);
    }
  );

  it("sends a known email-less author's follow-up after only a probe without fetching their profile", async () => {
    const userLookup = vi.fn(() => linearUserResponse({ ...AUTHOR, email: null }));
    const { actorRequests, activities } = await interact("follow_up", {
      initialEnrollResponse: async () => new Response(null, { status: 204 }),
      userLookup,
    });

    expect(actorRequests.map(({ path }) => path)).toEqual([
      "/actors/me",
      "/sessions/session-xyz/events",
      "/sessions/session-xyz/prompt",
    ]);
    expect(JSON.parse(String(actorRequests[0]?.body))).toEqual({});
    expect(userLookup).not.toHaveBeenCalled();
    expect(activities.some(({ type }) => type === "error")).toBe(false);
  });

  describe.each<Interaction>(["follow_up", "stop"])(
    "%s with an unavailable Linear profile",
    (interaction) => {
      it.each([true, false])(
        "defers to control-plane admission (admitted=%s)",
        async (admitted) => {
          const { actorRequests, activities, sessionMappingRetained, mappingDeleteCount } =
            await interact(interaction, {
              userLookup: () => new Response("unavailable", { status: 503 }),
              enrollResponse: async () =>
                admitted
                  ? new Response(null, { status: 204 })
                  : Response.json({ code: ACTOR_EMAIL_REQUIRED_CODE }, { status: 403 }),
            });

          expect(actorRequests.map(({ path }) => path)).toEqual(
            admitted ? SUCCESS_PATHS[interaction] : ENROLLMENT_PATHS[interaction]
          );
          const enrollment = actorRequests.filter(({ path }) => path === "/actors/me").at(-1);
          expect(JSON.parse(String(enrollment?.body))).toEqual({});
          expect(sessionMappingRetained).toBe(!(admitted && interaction === "stop"));
          expect(mappingDeleteCount).toBe(admitted && interaction === "stop" ? 1 : 0);
          expect(activities.filter(({ type }) => type === "error")).toEqual(
            admitted ? [] : [{ type: "error", body: FAILURE_COPY.email_required }]
          );
        }
      );
    }
  );

  it.each([400, 503])(
    "does not contact Linear or retry when the email-required stop response has status %s",
    async (status) => {
      const { actorRequests, sequence, sessionMappingRetained, mappingDeleteCount } =
        await interact("stop", {
          firstStopResponse: () => Response.json({ code: ACTOR_EMAIL_REQUIRED_CODE }, { status }),
        });

      expect(sequence).toEqual(["/sessions/session-xyz/stop"]);
      expect(actorRequests).toHaveLength(1);
      expect(sessionMappingRetained).toBe(true);
      expect(mappingDeleteCount).toBe(0);
    }
  );

  it("retains the mapping without enrollment or retry when credentials fail after the initial stop refusal", async () => {
    const { actorRequests, sequence, sessionMappingRetained, mappingDeleteCount } = await interact(
      "stop",
      {
        clientCredentials: () => new Response("unavailable", { status: 503 }),
      }
    );

    expect(sequence).toEqual(["/sessions/session-xyz/stop", "linear:credentials"]);
    expect(actorRequests).toHaveLength(1);
    expect(sessionMappingRetained).toBe(true);
    expect(mappingDeleteCount).toBe(0);
  });

  it("does not enroll again or delete the mapping when the retried stop still requires an email", async () => {
    const { actorRequests, sessionMappingRetained, mappingDeleteCount } = await interact("stop", {
      retryStopResponse: () => Response.json({ code: ACTOR_EMAIL_REQUIRED_CODE }, { status: 403 }),
    });

    expect(actorRequests.map(({ path }) => path)).toEqual(SUCCESS_PATHS.stop);
    expect(sessionMappingRetained).toBe(true);
    expect(mappingDeleteCount).toBe(0);
  });
});
