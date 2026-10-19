import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SlackIngressStore } from "../../src/db/slack-ingress";
import { cleanD1Tables } from "./cleanup";

const input = {
  source: "slack" as const,
  externalEventId: "Ev1",
  payloadJson: "{}",
  payloadSha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  channelId: "C1",
  threadTs: "1.2",
  stableSessionId: "slack-session-Ev1",
  stableMessageId: "slack-message-Ev1",
  deadlineAt: 20_000,
};
describe("SlackIngressStore", () => {
  beforeEach(cleanD1Tables);
  it("admits idempotently and rejects a changed duplicate", async () => {
    const store = new SlackIngressStore(env.DB);
    const first = await store.admit(input, 1_000);
    expect((await store.admit(input, 1_001)).id).toBe(first.id);
    await expect(
      store.admit(
        {
          ...input,
          payloadJson: '{"x":1}',
          payloadSha256: "5041bf1f713df204784353e82f6a4a535931cb64f1f4b4a5aeaffcb720918b22",
        },
        1_002
      )
    ).rejects.toThrow(/conflict/);
  });
  it("claims once, recovers an expired lease, CAS transitions, and cleans terminal rows", async () => {
    const store = new SlackIngressStore(env.DB);
    const admitted = await store.admit(input, 1_000);
    expect((await store.claim(admitted.id, "worker-a", 1_000, 2_000))?.attempts).toBe(1);
    expect(await store.claim(admitted.id, "worker-b", 1_000, 2_500)).toBeNull();
    await store.reconcile(3_001);
    expect((await store.claim(admitted.id, "worker-b", 1_000, 3_002))?.attempts).toBe(2);
    expect(
      await store.transition(
        admitted.id,
        "worker-a",
        "processing",
        "session_created",
        "s1",
        undefined,
        3_003
      )
    ).toBeNull();
    expect(
      (
        await store.transition(
          admitted.id,
          "worker-b",
          "processing",
          "session_created",
          "s1",
          undefined,
          3_003
        )
      )?.session_id
    ).toBe("s1");
    expect(
      (
        await store.transition(
          admitted.id,
          "worker-b",
          "session_created",
          "prompt_queued",
          undefined,
          undefined,
          3_004
        )
      )?.state
    ).toBe("prompt_queued");
    expect(
      (
        await store.transition(
          admitted.id,
          "worker-b",
          "prompt_queued",
          "completed",
          undefined,
          undefined,
          3_005
        )
      )?.state
    ).toBe("completed");
    expect(await store.cleanup(3_006)).toBe(1);
  });
  it("has one winner under concurrent claims and refuses work past its deadline", async () => {
    const store = new SlackIngressStore(env.DB);
    const admitted = await store.admit(input, 1_000);
    const claims = await Promise.all([
      store.claim(admitted.id, "a", 1_000, 2_000),
      store.claim(admitted.id, "b", 1_000, 2_000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const expired = await store.admit(
      {
        ...input,
        externalEventId: "Ev2",
        stableSessionId: "s2",
        stableMessageId: "m2",
        deadlineAt: 1_500,
      },
      1_000
    );
    expect(await store.claim(expired.id, "a", 1_000, 2_000)).toBeNull();
  });
});
