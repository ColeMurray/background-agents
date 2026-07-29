import { vi } from "vitest";
import type { Env } from "./types";

export const LINEAR_WEBHOOK_TEST_SECRET = "test-linear-webhook-secret";

export interface PutCall {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

export function createFakeKV(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const putCalls: PutCall[] = [];

  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key) ?? null;
      if (value === null) return null;
      if (type === "json") return JSON.parse(value) as unknown;
      return value;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, value);
      putCalls.push({ key, value, options });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };

  return { kv: kv as unknown as KVNamespace, store, putCalls };
}

export function makeLinearBotEnv(kv: KVNamespace, overrides: Partial<Env> = {}): Env {
  return {
    LINEAR_KV: kv,
    LINEAR_WEBHOOK_SECRET: LINEAR_WEBHOOK_TEST_SECRET,
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.example.test",
    WEB_APP_URL: "https://web.example.test",
    LINEAR_CLIENT_ID: "linear-client-id",
    LINEAR_CLIENT_SECRET: "linear-client-secret",
    WORKER_URL: "https://linear-bot.example.test",
    ANTHROPIC_API_KEY: "anthropic-key",
    SERVICE_AUTH_SECRET: "service-auth-secret",
    CONTROL_PLANE: { fetch: vi.fn() } as unknown as Fetcher,
    ...overrides,
  };
}

export function makeExecutionContext() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

interface LinearFetchRequest {
  accessToken?: string;
  body: Record<string, unknown>;
  operationName?: string;
  params?: URLSearchParams;
  signal?: AbortSignal | null;
}

interface LinearFetchHandlers {
  authorizationCode?: (request: LinearFetchRequest) => Response | Promise<Response>;
  clientCredentials?: (request: LinearFetchRequest) => Response | Promise<Response>;
  identity?: (request: LinearFetchRequest) => Response | Promise<Response>;
  graphql?: (request: LinearFetchRequest) => Response | Promise<Response>;
}

function readBearerToken(headers?: HeadersInit): string | undefined {
  const authorization = new Headers(headers).get("Authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
}

function readGraphQLOperationName(query: unknown): string | undefined {
  if (typeof query !== "string") return undefined;
  return /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
}

export function createLinearFetchMock(handlers: LinearFetchHandlers) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === "https://api.linear.app/oauth/token") {
      const params = init?.body as URLSearchParams;
      const grantType = params.get("grant_type");
      const handler =
        grantType === "authorization_code"
          ? handlers.authorizationCode
          : grantType === "client_credentials"
            ? handlers.clientCredentials
            : undefined;
      if (!handler) throw new Error(`Unexpected Linear OAuth grant: ${String(grantType)}`);
      return handler({ body: {}, params, signal: init?.signal });
    }

    if (url === "https://api.linear.app/graphql") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const operationName = readGraphQLOperationName(body.query);
      const handler =
        operationName === "LinearViewerIdentity" ? handlers.identity : handlers.graphql;
      if (!handler)
        throw new Error(`Unexpected Linear GraphQL operation: ${String(operationName)}`);
      return handler({
        accessToken: readBearerToken(init?.headers),
        body,
        operationName,
        signal: init?.signal,
      });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  });
}

export function linearClientCredentialsResponse(
  accessToken = "runtime-access-token",
  overrides: Record<string, unknown> = {}
): Response {
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 2_592_000,
    ...overrides,
  });
}

export function linearAuthorizationCodeResponse(): Response {
  return Response.json({
    access_token: "installation-access-token",
    refresh_token: "installation-refresh-token",
    token_type: "Bearer",
    expires_in: 86_399,
    scope: "read write app:assignable app:mentionable",
  });
}

export function linearIdentityResponse(
  organizationId = "org-1",
  appUserId = "app-user-1"
): Response {
  return Response.json({
    data: {
      viewer: {
        id: appUserId,
        organization: { id: organizationId, name: "Acme" },
      },
    },
  });
}

export async function signLinearWebhookRequest(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(LINEAR_WEBHOOK_TEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
