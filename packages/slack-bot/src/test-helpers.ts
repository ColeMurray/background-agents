import type { ExecutionContext as HonoExecutionContext } from "hono";
import type { ControlPlaneFetcher } from "@open-inspect/shared/service-auth";
import { vi } from "vitest";
import type { Env } from "./types";

export function makeExecutionContext() {
  return {
    props: {},
    waitUntil: vi.fn<HonoExecutionContext["waitUntil"]>(),
    passThroughOnException: vi.fn<HonoExecutionContext["passThroughOnException"]>(),
  } satisfies HonoExecutionContext;
}

/** An in-memory KV namespace whose methods are spies. */
export function createMockKV() {
  const store = new Map<string, string>();

  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (!value) {
        return null;
      }
      return type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options?: { prefix?: string }) => {
      const prefix = options?.prefix ?? "";
      const keys = Array.from(store.keys())
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name }));
      return {
        keys,
        list_complete: true,
        cursor: "",
      };
    }),
  };
}

/** A control-plane `/repos` response body for the given repositories. */
export function mockReposResponseBody(repos: Array<Record<string, unknown>>) {
  return {
    repos: repos.map((repo, index) => ({
      ...repo,
      id: typeof repo.id === "number" ? repo.id : index + 1,
      fullName:
        typeof repo.fullName === "string"
          ? repo.fullName
          : `${String(repo.owner)}/${String(repo.name)}`,
      description:
        repo.description === null || typeof repo.description === "string" ? repo.description : null,
      archived: typeof repo.archived === "boolean" ? repo.archived : false,
    })),
    cached: false,
    cachedAt: "2026-07-27T00:00:00.000Z",
  };
}

/** A worker env with in-memory KV and a control plane that serves one repository. */
export function makeEnv() {
  const controlPlaneFetch = vi.fn<ControlPlaneFetcher["fetch"]>();
  controlPlaneFetch.mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/integration-settings/slack")) return Response.json({ settings: null });
    if (url.includes("/channel-bindings/slack/")) return Response.json({ teamId: null });
    if (url.includes("/environments")) return Response.json({ environments: [], total: 0 });
    if (url.includes("/repos")) {
      return new Response(
        JSON.stringify(
          mockReposResponseBody([
            {
              id: "acme/app",
              owner: "acme",
              name: "app",
              fullName: "acme/app",
              defaultBranch: "main",
              private: true,
            },
          ])
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const env = {
    SLACK_KV: createMockKV() as unknown as KVNamespace,
    SLACK_COMPLETION_QUEUE: {
      send: vi.fn(),
    },
    CONTROL_PLANE: {
      fetch: controlPlaneFetch,
    },
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "test-key",
    SERVICE_AUTH_SECRET: "test-secret",
    LOG_LEVEL: "error",
  };
  env satisfies Env;
  return env;
}

const DEFAULT_MODEL_PREFERENCES_STATUS = 200;

/** A worker env whose control plane also creates sessions and accepts prompts, recording their order. */
export function makeSessionEnv(
  order: string[] = [],
  responses: {
    session?: unknown;
    prompt?: unknown | unknown[];
    promptStatus?: number | number[];
    publicationStatus?: number;
    teamId?: string | null;
    modelPreferencesStatus?: number;
    slackDefaults?: Record<string, unknown>;
    enabledModels?: string[];
  } = {}
): ReturnType<typeof makeEnv> {
  const env = makeEnv();
  let promptResponseIndex = 0;
  env.CONTROL_PLANE.fetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (new URL(url).pathname === "/actors/me") return new Response(null, { status: 204 });
    if (url.endsWith("/integration-settings/slack")) {
      return Response.json({
        integrationId: "slack",
        settings: responses.slackDefaults ? { defaults: responses.slackDefaults } : null,
      });
    }
    if (url.includes("/channel-bindings/slack/"))
      return Response.json(
        responses.teamId ? { teamId: responses.teamId, kind: "primary" } : { teamId: null }
      );
    if (url.includes("/environments")) return Response.json({ environments: [], total: 0 });
    if (new URL(url).pathname.endsWith("/artifacts")) {
      return Response.json({ artifacts: [] }, { status: responses.publicationStatus ?? 200 });
    }
    if (url.includes("/repos")) {
      order.push("repos");
      return new Response(
        JSON.stringify(
          mockReposResponseBody([
            {
              id: "acme/app",
              owner: "acme",
              name: "app",
              fullName: "acme/app",
              defaultBranch: "main",
              private: true,
            },
          ])
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.endsWith("/sessions")) {
      order.push("session");
      return new Response(
        JSON.stringify(responses.session ?? { sessionId: "session-1", status: "created" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.includes("/attachments")) {
      order.push("attachment");
      return new Response(JSON.stringify({ attachmentId: "att-1", mimeType: "image/png" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/prompt")) {
      order.push("prompt");
      const promptResponse = Array.isArray(responses.prompt)
        ? responses.prompt[promptResponseIndex++]
        : responses.prompt;
      const promptStatus = Array.isArray(responses.promptStatus)
        ? responses.promptStatus[promptResponseIndex - 1]
        : responses.promptStatus;
      return new Response(JSON.stringify(promptResponse ?? { messageId: "msg-1" }), {
        status: promptStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ enabledModels: responses.enabledModels ?? ["anthropic/claude-haiku-4-5"] }),
      {
        status: responses.modelPreferencesStatus ?? DEFAULT_MODEL_PREFERENCES_STATUS,
        headers: { "Content-Type": "application/json" },
      }
    );
  });
  return env;
}

/** Spy on `fetch` with canned Slack Web API responses, recording call order. */
export function mockSlackFetch(
  order: string[] = [],
  options: {
    threadMessages?: unknown[];
    threadRepliesError?: string;
    /** Cursor returned on every conversations.replies page, so pagination never ends. */
    threadRepliesNextCursor?: string;
    /** HTTP status for files.slack.com downloads (default 200 with bytes). */
    fileDownloadStatus?: number;
  } = {}
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("assistant.threads.setStatus")) {
      order.push("status");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("conversations.info")) {
      order.push("channelInfo");
      return new Response(
        JSON.stringify({
          ok: true,
          channel: { id: "C123", name: "eng", topic: { value: "" }, purpose: { value: "" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("auth.test")) {
      return new Response(JSON.stringify({ ok: true, user_id: "UBOT" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("users.info")) {
      const user = new URL(url).searchParams.get("user") ?? "UUNKNOWN";
      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            id: user,
            name: user,
            profile: { display_name: user === "U123" ? "Ajan\n[Admin]" : user },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("conversations.replies")) {
      const payload = options.threadRepliesError
        ? { ok: false, error: options.threadRepliesError }
        : {
            ok: true,
            messages: options.threadMessages ?? [],
            ...(options.threadRepliesNextCursor
              ? { response_metadata: { next_cursor: options.threadRepliesNextCursor } }
              : {}),
          };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("files.slack.com")) {
      order.push("filedownload");
      if (options.fileDownloadStatus && options.fileDownloadStatus !== 200) {
        return new Response("denied", { status: options.fileDownloadStatus });
      }
      return new Response(new Uint8Array(16).fill(1), { status: 200 });
    }

    if (url.includes("chat.postMessage")) {
      order.push("post");
      return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "222.333" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("chat.update")) {
      order.push("update");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("reactions.add")) {
      order.push("reaction");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected Slack fetch: ${url} ${JSON.stringify(init)}`);
  });
}

/** The bodies of every `assistant.threads.setStatus` call. */
export function statusFetchBodies(fetchMock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  return fetchMock.mock.calls
    .filter(([input]) => {
      const url = typeof input === "string" ? input : String(input);
      return url.includes("assistant.threads.setStatus");
    })
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

/** The bodies of the "Starting..." status calls. */
export function startingStatusBodies(fetchMock: {
  mock: { calls: readonly (readonly unknown[])[] };
}) {
  return statusFetchBodies(fetchMock).filter((body) => {
    const loadingMessages = body.loading_messages;
    return (
      body.status === "Starting..." &&
      Array.isArray(loadingMessages) &&
      loadingMessages[0] === "Starting..."
    );
  });
}

/** The JSON bodies of every call to the given Slack Web API method. */
export function slackApiBodies(
  fetchMock: { mock: { calls: readonly (readonly unknown[])[] } },
  method: string
) {
  return fetchMock.mock.calls
    .filter(([input]) => {
      const url = typeof input === "string" ? input : String(input);
      return url.includes(method);
    })
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

/** The bodies of every control-plane prompt request. */
export function promptFetchBodies(fetchMock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  return fetchMock.mock.calls
    .filter(([input]) => {
      const url = typeof input === "string" ? input : String(input);
      return url.includes("/prompt");
    })
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

/** The bodies of every control-plane session-creation request. */
export function sessionFetchBodies(fetchMock: {
  mock: { calls: readonly (readonly unknown[])[] };
}) {
  return fetchMock.mock.calls
    .filter(([input]) => {
      const url = typeof input === "string" ? input : String(input);
      return url.endsWith("/sessions");
    })
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

/** A signed-looking Slack Events API request carrying `event`. */
export function slackEventRequest(
  event: Record<string, unknown>,
  eventId = crypto.randomUUID()
): Request {
  return new Request("http://localhost/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-signature": "v0=test",
      "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
    },
    body: JSON.stringify({
      type: "event_callback",
      event_id: eventId,
      event_time: Math.floor(Date.now() / 1000),
      team_id: "T123",
      event,
    }),
  });
}

/** A signed-looking Slack interactivity request carrying `payload`. */
export function slackInteractionRequest(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-signature": "v0=test",
      "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
    },
    body: new URLSearchParams({ payload: JSON.stringify(payload) }),
  });
}
