import { describe, it, expect, beforeEach } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO } from "./helpers";

/**
 * Integration coverage for the server-side plan-approval → implementation
 * dispatch path. Before this landed, only the web client triggered the
 * implementation turn (by sending a follow-up WS prompt after the approve
 * call). Bots that only hit /internal/plan/approve never started the build.
 *
 * These tests assert the dispatch happens regardless of caller.
 */
describe("POST /internal/plan/approve dispatches implementation prompt", () => {
  beforeEach(cleanD1Tables);

  async function setupApprovedSession() {
    const { stub } = await initSession({ planMode: true });

    const saveRes = await stub.fetch("http://internal/internal/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Step 1: do thing\nStep 2: ship it" }),
    });
    expect(saveRes.status).toBe(201);

    const approveRes = await stub.fetch("http://internal/internal/plan/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(approveRes.status).toBe(200);

    return { stub };
  }

  it("enqueues a system-authored implementation prompt referencing the approved plan version", async () => {
    const { stub } = await setupApprovedSession();

    const messages = await queryDO<{
      content: string;
      source: string;
      author_id: string;
    }>(stub, "SELECT content, source, author_id FROM messages ORDER BY created_at");

    const systemMsg = messages.find((m) => m.source === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toMatch(/Implement the approved plan v1\./);
    expect(systemMsg!.content).toMatch(/Follow its steps exactly/);
    expect(systemMsg!.author_id).toEqual(expect.any(String));
  });

  it("creates a stable system participant attached to the synthetic prompt", async () => {
    const { stub } = await setupApprovedSession();

    const participants = await queryDO<{ id: string; user_id: string; scm_name: string | null }>(
      stub,
      "SELECT id, user_id, scm_name FROM participants WHERE user_id = 'system'"
    );
    expect(participants).toHaveLength(1);
    expect(participants[0].scm_name).toBe("System");

    const messages = await queryDO<{ author_id: string }>(
      stub,
      "SELECT author_id FROM messages WHERE source = 'system'"
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].author_id).toBe(participants[0].id);
  });

  it("re-uses the existing system participant on a second plan/approve cycle", async () => {
    const { stub } = await initSession({ planMode: true });

    // Cycle 1: save → approve. Plan v1.
    await stub.fetch("http://internal/internal/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "plan one" }),
    });
    await stub.fetch("http://internal/internal/plan/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // Cycle 2: save a new plan (bumps version → v2) and approve.
    await stub.fetch("http://internal/internal/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "plan two" }),
    });
    await stub.fetch("http://internal/internal/plan/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'system'"
    );
    expect(participants).toHaveLength(1);

    const systemMessages = await queryDO<{ content: string }>(
      stub,
      "SELECT content FROM messages WHERE source = 'system' ORDER BY created_at"
    );
    expect(systemMessages).toHaveLength(2);
    expect(systemMessages[0].content).toMatch(/v1\./);
    expect(systemMessages[1].content).toMatch(/v2\./);
  });
});
