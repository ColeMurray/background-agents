import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { PrAutofixFeedbackStore } from "../../src/db/pr-autofix-feedback-store";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const BASE = "https://test.local/autofix/activity";

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

  it("paginates real feedback activity through the Worker route", async () => {
    const store = new PrAutofixFeedbackStore(env.DB);
    await store.receive(envelope("older"), 1_000);
    await store.receive(envelope("newer"), 2_000);

    const first = await serviceFetch(`${BASE}?limit=1`);
    expect(first.status).toBe(200);
    const firstBody = await first.json<{
      records: Array<{ feedbackKey: string; deliveryId: string }>;
      nextCursor: string | null;
    }>();
    expect(firstBody.records).toEqual([
      expect.objectContaining({
        feedbackKey: "github:pr_comment:newer",
        deliveryId: "delivery-newer",
      }),
    ]);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = await serviceFetch(
      `${BASE}?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          feedbackKey: "github:pr_comment:older",
          deliveryId: "delivery-older",
        }),
      ],
      nextCursor: null,
    });
  });

  it("uses the default limit and newest-first ordering", async () => {
    const store = new PrAutofixFeedbackStore(env.DB);
    await store.receive(envelope("first"), 1_000);
    await store.receive(envelope("second"), 2_000);

    const response = await serviceFetch(BASE);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      records: [
        expect.objectContaining({ feedbackKey: "github:pr_comment:second" }),
        expect.objectContaining({ feedbackKey: "github:pr_comment:first" }),
      ],
      nextCursor: null,
    });
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
