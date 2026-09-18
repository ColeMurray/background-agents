import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  updateClaimedPendingRequestLaunchState,
  updatePendingRequestLaunchState,
  type PendingRequest,
} from "../../../slack-bot/src/pending-requests/pending-request-store";
import type { Env as SlackEnv } from "../../../slack-bot/src/types";
import { cleanD1Tables } from "./cleanup";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";

function makeEnv(): SlackEnv {
  const pending: PendingRequest = {
    requestId: REQUEST_ID,
    channel: "C123",
    threadTs: "111.222",
    message: "Fix the tests",
    userId: "U123",
  };
  return {
    DB: env.DB,
    SLACK_KV: {
      get: async () => pending,
    } as unknown as KVNamespace,
  } as SlackEnv;
}

describe("Slack pending launch states", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("atomically preserves the first target selected by concurrent retries", async () => {
    const slackEnv = makeEnv();
    const states = await Promise.all([
      updatePendingRequestLaunchState(
        slackEnv,
        { requestId: REQUEST_ID },
        {
          selectedValue: "acme/app",
        }
      ),
      updatePendingRequestLaunchState(
        slackEnv,
        { requestId: REQUEST_ID },
        {
          selectedValue: "acme/api",
        }
      ),
    ]);

    expect(new Set(states.map((state) => state?.launchState?.selectedValue)).size).toBe(1);
  });

  it("clears stale attachment references when replacing a session", async () => {
    const slackEnv = makeEnv();
    const snapshot = {
      model: "openai/gpt-5.4",
      content: "Fix the tests",
      callbackContext: {
        source: "slack" as const,
        channel: "C123",
        threadTs: "111.222",
        repoFullName: "acme/app",
        model: "openai/gpt-5.4",
      },
    };
    await updatePendingRequestLaunchState(
      slackEnv,
      { requestId: REQUEST_ID },
      {
        selectedValue: "acme/app",
        sessionId: "session-old",
        snapshot: {
          ...snapshot,
          attachmentReferences: [{ attachmentId: "att-old", name: "old.png" }],
          attachmentDrops: ["upload_rejected"],
        },
      }
    );

    const updated = await updateClaimedPendingRequestLaunchState(
      slackEnv,
      { requestId: REQUEST_ID },
      { selectedValue: "acme/app", sessionId: "session-new", snapshot },
      "session-old"
    );

    expect(updated).toEqual({
      selectedValue: "acme/app",
      sessionId: "session-new",
      snapshot,
    });
  });

  it("continues a claimed launch without re-reading its pending KV record", async () => {
    const slackEnv = makeEnv();
    await updatePendingRequestLaunchState(
      slackEnv,
      { requestId: REQUEST_ID },
      {
        selectedValue: "acme/app",
      }
    );
    slackEnv.SLACK_KV = {
      get: async () => null,
    } as unknown as KVNamespace;

    const updated = await updateClaimedPendingRequestLaunchState(
      slackEnv,
      { requestId: REQUEST_ID },
      { selectedValue: "acme/app", sessionId: "session-1" }
    );

    expect(updated).toEqual({ selectedValue: "acme/app", sessionId: "session-1" });
  });
});
