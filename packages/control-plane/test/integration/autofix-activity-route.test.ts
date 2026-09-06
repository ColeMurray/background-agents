import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { PrAutofixFeedbackStore } from "../../src/db/pr-autofix-feedback-store";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const BASE = "https://test.local/autofix/activity";
const DEFAULT_ACTIVITY_LIMIT = 50;

function envelope(id: string): GitHubAutofixEnvelope {
  return {
    version: 1,
    eventType: "issue_comment",
    action: "created",
    deliveryId: `delivery-${id}`,
    providerObject: { kind: "pr_comment", id },
    repository: { id: "99", owner: "acme", name: "widgets" },
    pullRequestNumber: 42,
    receivedAt: "2026-09-02T00:00:00.000Z",
  };
}

describe("GET /autofix/activity", () => {
  beforeEach(cleanD1Tables);

  it("applies the default limit and paginates equal-timestamp records without gaps", async () => {
    const store = new PrAutofixFeedbackStore(env.DB);
    const ids = Array.from(
      { length: DEFAULT_ACTIVITY_LIMIT + 1 },
      (_, index) => `record-${String(index).padStart(2, "0")}`
    );
    for (const id of ids) await store.receive(envelope(id), 1_000);
    const expectedKeys = ids.map((id) => `github:pr_comment:${id}`).reverse();

    const first = await serviceFetch(BASE);
    expect(first.status).toBe(200);
    const firstBody = await first.json<{
      records: Array<{ feedbackKey: string }>;
      nextCursor: string | null;
    }>();
    expect(firstBody.records).toHaveLength(DEFAULT_ACTIVITY_LIMIT);
    expect(firstBody.records.map((record) => record.feedbackKey)).toEqual(
      expectedKeys.slice(0, DEFAULT_ACTIVITY_LIMIT)
    );
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = await serviceFetch(
      `${BASE}?cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json<{
      records: Array<{ feedbackKey: string }>;
      nextCursor: string | null;
    }>();
    expect(secondBody.records.map((record) => record.feedbackKey)).toEqual(
      expectedKeys.slice(DEFAULT_ACTIVITY_LIMIT)
    );
    expect(secondBody.nextCursor).toBeNull();

    const traversedKeys = [...firstBody.records, ...secondBody.records].map(
      (record) => record.feedbackKey
    );
    expect(traversedKeys).toEqual(expectedKeys);
    expect(new Set(traversedKeys).size).toBe(ids.length);
  });

  it("rejects invalid limits and cursors at the route boundary", async () => {
    for (const limit of ["0", "101", "1.5", "abc", "Infinity"]) {
      const response = await serviceFetch(`${BASE}?limit=${encodeURIComponent(limit)}`);
      expect(response.status, limit).toBe(400);
      await expect(response.json(), limit).resolves.toEqual({
        error: "limit must be an integer from 1 to 100",
      });
    }

    const invalidCursor = await serviceFetch(`${BASE}?cursor=not-a-cursor`);
    expect(invalidCursor.status).toBe(400);
    await expect(invalidCursor.json()).resolves.toEqual({
      error: "Invalid Autofix activity cursor",
    });
  });

  it("accepts only the authenticated web-service channel", async () => {
    const unsigned = await SELF.fetch(BASE);
    expect(unsigned.status).toBe(401);

    const bot = await serviceFetch(BASE, { service: "slack-bot" });
    expect(bot.status).toBe(401);

    const web = await serviceFetch(BASE);
    expect(web.status).toBe(200);
  });
});
