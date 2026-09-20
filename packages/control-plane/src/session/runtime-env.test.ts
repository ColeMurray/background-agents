import { expect, it } from "vitest";
import type { Env } from "../types";
import { createSessionRuntimeEnv } from "./runtime-env";

it("does not retain callback delivery capabilities in a session environment", () => {
  const jobs = { send: async () => {} };
  const env = createSessionRuntimeEnv({
    JOBS: jobs,
    SLACK_BOT: {},
    LINEAR_BOT: {},
    SERVICE_AUTH_SECRET_SLACK_BOT: "slack",
    SERVICE_AUTH_SECRET_LINEAR_BOT: "linear",
    SERVICE_AUTH_SECRET_WEB: "web",
  } as unknown as Env);
  expect(env.JOBS).toBe(jobs);
  expect(env.SERVICE_AUTH_SECRET_WEB).toBe("web");
  for (const key of [
    "SLACK_BOT",
    "LINEAR_BOT",
    "SERVICE_AUTH_SECRET_SLACK_BOT",
    "SERVICE_AUTH_SECRET_LINEAR_BOT",
  ]) {
    expect(env).not.toHaveProperty(key);
  }
});
