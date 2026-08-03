import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SessionCreationIdempotencyStore } from "../../src/db/session-creation-idempotency";
import { cleanD1Tables } from "./cleanup";

describe("SessionCreationIdempotencyStore", () => {
  beforeEach(cleanD1Tables);

  it("assigns a fresh session after a failed attempt and replays success", async () => {
    const store = new SessionCreationIdempotencyStore(env.DB);

    await expect(store.claim("request-1", "session-1")).resolves.toEqual({
      outcome: "claimed",
      sessionId: "session-1",
    });
    await store.markFailed("request-1", "session-1");
    await expect(store.claim("request-1", "session-2")).resolves.toEqual({
      outcome: "claimed",
      sessionId: "session-2",
    });
    await store.markSucceeded("request-1", "session-2");

    await expect(store.claim("request-1", "session-3")).resolves.toEqual({
      outcome: "succeeded",
      sessionId: "session-2",
    });
  });

  it("reports a live initialization lease as in progress", async () => {
    const store = new SessionCreationIdempotencyStore(env.DB);
    await store.claim("request-1", "session-1");

    await expect(store.claim("request-1", "session-2")).resolves.toEqual({
      outcome: "in_progress",
    });
  });
});
