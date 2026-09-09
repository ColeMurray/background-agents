import { describe, expect, it, vi } from "vitest";
import {
  handleRequest,
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "./router.test-support";

function createEnv() {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };
  return {
    ...TEST_SERVICE_SECRETS,
    DB: {
      prepare: vi.fn(() => statement),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
    },
  };
}

describe("Autofix operator routes", () => {
  it("allows the signed web service to read deployment activity", async () => {
    const response = await handleRequest(
      await signedServiceRequest("https://test.local/autofix/activity", {
        service: "web",
      }),
      createEnv() as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ records: [], nextCursor: null });
  });

  it.each([
    ["?limit=0", "limit must be an integer from 1 to 100"],
    ["?limit=abc", "limit must be an integer from 1 to 100"],
    ["?limit=101", "limit must be an integer from 1 to 100"],
    ["?limit=5&limit=6", "Invalid limit"],
  ])("rejects the activity query %s", async (query, error) => {
    const response = await handleRequest(
      await signedServiceRequest(`https://test.local/autofix/activity${query}`, {
        service: "web",
      }),
      createEnv() as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
  });

  it("rejects another authenticated service from deployment activity", async () => {
    const response = await handleRequest(
      await signedServiceRequest("https://test.local/autofix/activity", {
        service: "github-bot",
      }),
      createEnv() as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(401);
  });
});
