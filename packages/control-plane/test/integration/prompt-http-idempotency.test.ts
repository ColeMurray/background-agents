import { describe, expect, it } from "vitest";
import {
  collectMessages,
  initSession,
  openClientWs,
  queryDO,
  seedMessage,
  serviceFetch,
} from "./helpers";
import { runInSessionDO } from "./session-do-access";
import { MAX_UNFINISHED_PROMPTS } from "@open-inspect/shared/types/prompts";

describe("web HTTP prompt admission identity (real session SQLite)", () => {
  it("recovers a lost response without reclaiming an attachment or admitting more work", async () => {
    const { stub, sessionName } = await initSession();
    const attachmentId = crypto.randomUUID();
    const secondAttachmentId = crypto.randomUUID();
    for (const id of [attachmentId, secondAttachmentId]) {
      const recorded = await stub.fetch("http://internal/internal/attachments", {
        method: "POST",
        body: JSON.stringify({
          action: "record",
          attachmentId: id,
          mimeType: "image/png",
          sizeBytes: 42,
        }),
      });
      expect(recorded.status).toBe(200);
    }
    const request = {
      content: "Check image",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "high",
      attachments: [
        { name: "image.png", attachmentId },
        { name: "second.png", attachmentId: secondAttachmentId },
      ],
      clientRequestId: crypto.randomUUID(),
    };
    const send = (body: Record<string, unknown> = request) =>
      serviceFetch(`https://test.local/sessions/${sessionName}/prompt`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    // The caller loses the first HTTP response; only its key and body survive.
    await send();
    const [{ id: originalId }] = await queryDO<{ id: string }>(stub, "SELECT id FROM messages");
    const retry = await send();
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ messageId: originalId, status: "queued" });
    const rows = await queryDO<{ id: string; client_request_id: string }>(
      stub,
      "SELECT id, client_request_id FROM messages"
    );
    expect(rows).toEqual([{ id: originalId, client_request_id: request.clientRequestId }]);
    for (const id of [attachmentId, secondAttachmentId]) {
      expect(await queryDO(stub, "SELECT message_id FROM attachments WHERE id = ?", id)).toEqual([
        { message_id: originalId },
      ]);
    }

    const conflictBodies = [
      { content: "Changed" },
      { model: "openai/gpt-5.4" },
      { reasoningEffort: "low" },
      { attachments: [] },
      { attachments: [{ name: "other.png", attachmentId: "other" }] },
      { attachments: [...request.attachments].reverse() },
    ];
    for (const change of conflictBodies) {
      const conflict = await send({ ...request, ...change });
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toMatchObject({ code: "PROMPT_REQUEST_CONFLICT" });
    }
    const otherParticipant = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      body: JSON.stringify({ ...request, authorId: "someone-else", source: "web" }),
    });
    expect(otherParticipant.status).toBe(409);
    await expect(otherParticipant.json()).resolves.toMatchObject({
      code: "PROMPT_REQUEST_CONFLICT",
    });

    const newKey = await send({
      ...request,
      attachments: [],
      clientRequestId: crypto.randomUUID(),
    });
    expect(newKey.status).toBe(200);
    expect((await newKey.json<{ messageId: string }>()).messageId).not.toBe(originalId);
    const legacy = await send({ content: "Check image" });
    expect(legacy.status).toBe(200);
    expect((await legacy.json<{ messageId: string }>()).messageId).not.toBe(originalId);
    expect(
      (await queryDO<{ count: number }>(stub, "SELECT COUNT(*) AS count FROM messages"))[0].count
    ).toBe(3);
  });

  it("returns the original in pending, processing and completed states despite budget and capacity", async () => {
    const { stub, sessionName } = await initSession();
    const body = { content: "Only once", clientRequestId: crypto.randomUUID() };
    const send = () =>
      serviceFetch(`https://test.local/sessions/${sessionName}/prompt`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    const first = await send();
    expect(first.status).toBe(200);
    const { messageId } = await first.json<{ messageId: string }>();
    const [{ author_id: authorId }] = await queryDO<{ author_id: string }>(
      stub,
      "SELECT author_id FROM messages WHERE id = ?",
      messageId
    );
    for (let index = 1; index < MAX_UNFINISHED_PROMPTS; index++) {
      await seedMessage(stub, {
        id: `filler-${index}`,
        authorId,
        content: "Other work",
        source: "web",
        status: "pending",
        createdAt: Date.now() + index,
      });
    }
    const full = await serviceFetch(`https://test.local/sessions/${sessionName}/prompt`, {
      method: "POST",
      body: JSON.stringify({ ...body, clientRequestId: crypto.randomUUID() }),
    });
    expect(full.status).toBe(429);
    await expect(full.json()).resolves.toMatchObject({ code: "PROMPT_QUEUE_FULL" });
    expect((await send()).status).toBe(200);
    await runInSessionDO(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET budget_exhausted = 1");
    });
    for (const status of ["pending", "processing", "completed"]) {
      await runInSessionDO(stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE messages SET status = ? WHERE id = ?", status, messageId);
      });
      const retry = await send();
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toMatchObject({ messageId });
    }
    expect((await send()).status).toBe(200);
    const newKey = await serviceFetch(`https://test.local/sessions/${sessionName}/prompt`, {
      method: "POST",
      body: JSON.stringify({ ...body, clientRequestId: crypto.randomUUID() }),
    });
    expect(newKey.status).toBe(409);
    await expect(newKey.json()).resolves.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    await runInSessionDO(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET status = 'archived'");
    });
    expect((await send()).status).toBe(409);
  });

  it("serializes concurrent HTTP/HTTP and HTTP/WebSocket requests on the same stored key", async () => {
    const { stub, sessionName } = await initSession();
    const { ws } = await openClientWs(sessionName, {
      subscribe: true,
      userId: "11111111111111111111111111111111",
    });
    const body = { content: "Concurrent", clientRequestId: crypto.randomUUID() };
    const send = (request = body) =>
      serviceFetch(`https://test.local/sessions/${sessionName}/prompt`, {
        method: "POST",
        body: JSON.stringify(request),
      });
    const [one, two] = await Promise.all([send(), send()]);
    expect([one.status, two.status]).toEqual([200, 200]);
    const originalId = (await one.json<{ messageId: string }>()).messageId;
    expect((await two.json<{ messageId: string }>()).messageId).toBe(originalId);

    const second = {
      ...body,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "high",
      clientRequestId: crypto.randomUUID(),
    };
    const collector = collectMessages(ws, { until: (message) => message.type === "prompt_queued" });
    ws.send(JSON.stringify({ type: "prompt", ...second }));
    const [http, messages] = await Promise.all([send(second), collector]);
    expect(http.status).toBe(200);
    const secondId = (await http.json<{ messageId: string }>()).messageId;
    expect(secondId).not.toBe(originalId);
    expect(messages.find((message) => message.type === "prompt_queued")).toMatchObject({
      messageId: secondId,
    });
    expect(
      (await queryDO<{ count: number }>(stub, "SELECT COUNT(*) AS count FROM messages"))[0].count
    ).toBe(2);
    ws.close();
  });

  it("rejects keyed bot work and invalid keys while retaining legacy bot prompts", async () => {
    const { sessionName } = await initSession();
    const url = `https://test.local/sessions/${sessionName}/prompt`;
    for (const clientRequestId of ["", "x".repeat(129)]) {
      expect(
        (
          await serviceFetch(url, {
            method: "POST",
            body: JSON.stringify({ content: "Hi", clientRequestId }),
          })
        ).status
      ).toBe(400);
    }
    const keyedBot = await serviceFetch(url, {
      service: "slack-bot",
      actor: "slack:U1",
      method: "POST",
      body: JSON.stringify({ content: "Hi", clientRequestId: "bot-key" }),
    });
    expect(keyedBot.status).toBe(400);
    const legacyBot = await serviceFetch(url, {
      service: "slack-bot",
      actor: "slack:U1",
      method: "POST",
      body: JSON.stringify({ content: "Hi" }),
    });
    expect(legacyBot.status).toBe(200);
  });
});
