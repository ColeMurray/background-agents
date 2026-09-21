import type { KeyValueStore } from "@open-inspect/shared/cache-store";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { handleIntegrationHttp } from "./http";

const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
};

const store = {
  get: vi.fn(async () => null),
  put: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
  list: vi.fn(async () => ({ keys: [] })),
} as unknown as KeyValueStore;

const controlPlane = { fetch: vi.fn(async () => Response.json({ repos: [] })) };

function env(overrides: Partial<Env>): Env {
  return {
    DEPLOYMENT_NAME: "test",
    GITHUB_BOT_USERNAME: "open-inspect[bot]",
    WEB_APP_URL: "https://app.example.test",
    TOKEN_ENCRYPTION_KEY: "test",
    PROVIDER_ACCOUNTS_ENCRYPTION_KEY: "test",
    DB: {} as Env["DB"],
    SESSION: {} as Env["SESSION"],
    REPOS_CACHE: store,
    MEDIA_BUCKET: {} as Env["MEDIA_BUCKET"],
    JOBS: { send: vi.fn(async () => undefined) },
    ...overrides,
  };
}

describe("handleIntegrationHttp", () => {
  it("leaves ordinary control-plane routes alone", async () => {
    await expect(
      handleIntegrationHttp(
        new Request("https://worker.example.test/sessions"),
        env({}),
        executionCtx,
        controlPlane
      )
    ).resolves.toBeNull();
  });

  it("serves the Slack app under its integration prefix", async () => {
    const response = await handleIntegrationHttp(
      new Request("https://worker.example.test/integrations/slack/health"),
      env({
        SLACK_KV: store,
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_SIGNING_SECRET: "signing",
        SLACK_BOT_DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
        CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
        SERVICE_AUTH_SECRET_SLACK_BOT: "service-secret",
      }),
      executionCtx,
      controlPlane
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      status: "healthy",
      service: "open-inspect-slack-bot",
      repoCount: 0,
    });
  });

  it("returns unavailable when the selected integration is disabled", async () => {
    const response = await handleIntegrationHttp(
      new Request("https://worker.example.test/integrations/linear/health"),
      env({}),
      executionCtx,
      controlPlane
    );

    expect(response?.status).toBe(503);
  });
});
