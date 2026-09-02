/**
 * Test-only builder for service-authenticated router requests.
 *
 * sig1 binds method, URL, and body, so every request is signed individually
 * — there is no reusable Authorization header. Env fixtures must bind the
 * matching `SERVICE_AUTH_SECRET_<SERVICE>` (see TEST_SERVICE_SECRETS).
 */

import { buildServiceAuthHeaders, type ServiceName } from "@open-inspect/shared/service-auth";
import type { BackgroundTasks } from "./platform-ports";
import { createTestBackgroundTasks } from "./background-tasks.test-support";
import {
  createControlPlaneHttpHandler,
  handleControlPlaneHttp,
  type ControlPlaneHttpHandler,
} from "./routing/hono-app";
import type { Route } from "./routes/shared";
import type { Env } from "./types";

// The single contract-faithful double lives in background-tasks.test-support;
// this shared instance's recordings are unused by the router suites.
export const TEST_BACKGROUND_TASK_CONTEXT: BackgroundTasks = createTestBackgroundTasks();

function executionContextFromBackgroundTasks(tasks: BackgroundTasks): ExecutionContext {
  return {
    waitUntil(promise): void {
      tasks.submit(() => promise, { name: "test.http.request" });
    },
    passThroughOnException(): void {},
  } as ExecutionContext;
}

/** Request handler signature used by unit fixtures that provide the platform-neutral port. */
export type TestRequestHandler = (
  request: Request,
  env: Env,
  backgroundTasks: BackgroundTasks
) => Promise<Response>;

function adaptForTests(handler: ControlPlaneHttpHandler): TestRequestHandler {
  return (request, env, backgroundTasks) =>
    handler(request, env, executionContextFromBackgroundTasks(backgroundTasks));
}

/** Test-only adapter over the production catalog. */
export const handleRequest: TestRequestHandler = adaptForTests(handleControlPlaneHttp);

/**
 * Test-only adapter over an explicit catalog. Hono registers routes when the
 * app is built, so fixtures that need synthetic routes construct their own
 * handler instead of mutating the production catalog.
 */
export function createTestRequestHandler(catalog: readonly Route[]): TestRequestHandler {
  return adaptForTests(createControlPlaneHttpHandler(catalog));
}

/** Per-service secrets for unit-test env fixtures, mirrored by signedServiceRequest. */
export const TEST_SERVICE_SECRETS = {
  SERVICE_AUTH_SECRET_WEB: "test-service-secret-web",
  SERVICE_AUTH_SECRET_SLACK_BOT: "test-service-secret-slack-bot",
  SERVICE_AUTH_SECRET_GITHUB_BOT: "test-service-secret-github-bot",
  SERVICE_AUTH_SECRET_LINEAR_BOT: "test-service-secret-linear-bot",
} as const;

export async function signedServiceRequest(
  url: string,
  init?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    service?: ServiceName;
    actor?: string;
  }
): Promise<Request> {
  const method = init?.method ?? "GET";
  const service = init?.service ?? "web";
  const auth = await buildServiceAuthHeaders({
    service,
    secret: `test-service-secret-${service}`,
    method,
    url,
    body: init?.body,
    actor: init?.actor,
  });
  return new Request(url, {
    method,
    headers: {
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
      ...auth,
    },
    body: init?.body,
  });
}
