import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SlackIngressStore } from "../../src/db/slack-ingress";
import { cleanD1Tables } from "./cleanup";
import { queryDO } from "./helpers";
import { serviceFetch } from "./helpers";

const sessionId = "slack-session-stable";
const messageId = "slack-message-stable";
describe("Slack ingress session idempotency", () => {
  beforeEach(cleanD1Tables);
  it("reuses the stable D1/SessionDO identity and first message across response-loss retries", async () => {
    const receipt = await new SlackIngressStore(env.DB).admit(
      {
        source: "slack",
        externalEventId: "Ev-stable",
        payloadJson: "{}",
        payloadSha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        channelId: "D1",
        threadTs: "1.2",
        stableSessionId: sessionId,
        stableMessageId: messageId,
        deadlineAt: Date.now() + 60_000,
      },
      Date.now()
    );
    await new SlackIngressStore(env.DB).claim(receipt.row.id, "worker", 60_000, Date.now());
    const body = JSON.stringify({
      title: "Durable Slack",
      model: "anthropic/claude-haiku-4-5",
      ingress: { receiptId: receipt.row.id, sessionId },
    });
    expect(
      (
        await serviceFetch("https://test.local/sessions", {
          service: "linear-bot",
          method: "POST",
          actor: "linear:U-FORGED",
          body,
        })
      ).status
    ).toBe(403);
    const create = () =>
      serviceFetch("https://test.local/sessions", {
        service: "slack-bot",
        method: "POST",
        actor: "slack:U-STABLE",
        body,
      });
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);
    const rows = await env.DB.prepare("SELECT id FROM sessions WHERE id=?").bind(sessionId).all();
    expect(rows.results).toHaveLength(1);
    const promptBody = JSON.stringify({
      content: "hello",
      source: "slack",
      clientRequestId: messageId,
    });
    expect(
      (
        await serviceFetch(`https://test.local/sessions/${sessionId}/prompt`, {
          service: "linear-bot",
          method: "POST",
          actor: "linear:U-FORGED",
          body: promptBody,
        })
      ).status
    ).toBe(403);
    const prompt = () =>
      serviceFetch(`https://test.local/sessions/${sessionId}/prompt?channel=slack:D1`, {
        service: "slack-bot",
        method: "POST",
        actor: "slack:U-STABLE",
        body: promptBody,
      });
    expect((await prompt()).status).toBe(200);
    expect((await prompt()).status).toBe(200);
    const stub = env.SESSION.getByName(sessionId);
    expect(await queryDO(stub, "SELECT id FROM messages WHERE id=?", messageId)).toHaveLength(1);
  });
});
