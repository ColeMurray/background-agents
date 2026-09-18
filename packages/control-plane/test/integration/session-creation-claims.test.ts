import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionCreationClaimStore,
  SessionCreationRequestConflictError,
} from "../../src/db/session-creation-claims";
import { cleanD1Tables } from "./cleanup";

describe("session creation claims", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("atomically assigns one session to concurrent retries", async () => {
    const store = new SessionCreationClaimStore(env.DB);
    const base = {
      userScope: "user-1",
      clientRequestId: "slack-request-1",
      requestFingerprint: "fingerprint-1",
      now: 1_700_000_000_000,
    };

    const claims = await Promise.all([
      store.claim({ ...base, sessionId: "session-a" }),
      store.claim({ ...base, sessionId: "session-b" }),
    ]);

    expect(new Set(claims.map((claim) => claim.sessionId)).size).toBe(1);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM session_creation_claims"
    ).first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it("rejects reuse with a different request fingerprint", async () => {
    const store = new SessionCreationClaimStore(env.DB);
    await store.claim({
      userScope: "user-1",
      clientRequestId: "slack-request-1",
      requestFingerprint: "fingerprint-1",
      sessionId: "session-a",
      now: 1_700_000_000_000,
    });

    await expect(
      store.claim({
        userScope: "user-1",
        clientRequestId: "slack-request-1",
        requestFingerprint: "fingerprint-2",
        sessionId: "session-b",
        now: 1_700_000_000_001,
      })
    ).rejects.toBeInstanceOf(SessionCreationRequestConflictError);
  });
});
