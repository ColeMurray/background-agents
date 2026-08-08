import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EnvironmentStore } from "../../src/db/environments";
import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  queryDO,
  initNamedSession,
  openClientWs,
  seedEvents,
  waitForSandboxStatus,
} from "./helpers";

describe("session bootstrap and V2 synchronization", () => {
  beforeEach(cleanD1Tables);

  it("resolves the live environment name in bootstrap snapshots", async () => {
    const now = Date.now();
    await new EnvironmentStore(env.DB).create(
      {
        id: "env-bootstrap",
        name: "Bootstrap environment",
        description: null,
        prebuild_enabled: 0,
        channel_associations: null,
        created_at: now,
        updated_at: now,
      },
      []
    );
    const name = `bootstrap-environment-${now}`;
    const { stub } = await initNamedSession(name, { environmentId: "env-bootstrap" });

    const bootstrap = await (
      await stub.fetch("http://internal/internal/bootstrap")
    ).json<Record<string, any>>();
    expect(bootstrap.state).toMatchObject({
      environmentId: "env-bootstrap",
      environmentName: "Bootstrap environment",
    });

    const snapshot = await openClientWs(name, {
      subscribe: true,
      viewProtocol: 2,
      forceSnapshot: true,
    });
    expect(snapshot.messages![1].bootstrap).toMatchObject({
      state: {
        environmentId: "env-bootstrap",
        environmentName: "Bootstrap environment",
      },
    });
    snapshot.ws.close();
  });
  it("returns an atomic secret-free bootstrap with stable event identities", async () => {
    const name = `bootstrap-${Date.now()}`;
    const { stub } = await initNamedSession(name, { title: "Bootstrap session" });
    await waitForSandboxStatus(stub, "failed");
    const createdAt = Date.now();
    await seedEvents(stub, [
      {
        id: "stable-event-1",
        type: "tool_result",
        data: JSON.stringify({
          type: "tool_result",
          sandboxId: "sandbox-1",
          timestamp: createdAt,
          messageId: "message-1",
          callId: "call-1",
          result: "ok",
        }),
        createdAt,
      },
    ]);
    await queryDO(
      stub,
      `UPDATE sandbox SET code_server_url = ?, code_server_password = ?, ttyd_url = ?, ttyd_token = ?`,
      "https://code.example.test",
      "code-secret",
      "https://terminal.example.test",
      "terminal-secret"
    );

    const response = await stub.fetch("http://internal/internal/bootstrap");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const bootstrap = await response.json<Record<string, any>>();

    expect(bootstrap.sessionId).toBe(name);
    expect(bootstrap.state.id).toBe(name);
    expect(bootstrap.state.codeServerUrl).toBe("https://code.example.test");
    expect(bootstrap.state).not.toHaveProperty("codeServerPassword");
    expect(bootstrap.state).not.toHaveProperty("ttydToken");
    expect(JSON.stringify(bootstrap)).not.toContain("code-secret");
    expect(JSON.stringify(bootstrap)).not.toContain("terminal-secret");
    expect(bootstrap.replay.events).toContainEqual({
      eventId: "stable-event-1",
      timelineSequence: expect.any(Number),
      event: {
        type: "tool_result",
        sandboxId: "sandbox-1",
        timestamp: createdAt,
        messageId: "message-1",
        callId: "call-1",
        result: "ok",
      },
    });
  });

  it("sends a V2 snapshot through session_ready before registering the live mapping", async () => {
    const name = `v2-snapshot-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await waitForSandboxStatus(stub, "failed");

    const { ws, messages } = await openClientWs(name, {
      subscribe: true,
      viewProtocol: 2,
      forceSnapshot: true,
    });
    expect(messages!.map((message) => message.type)).toEqual([
      "session_sync_started",
      "session_snapshot",
      "session_ready",
    ]);
    const started = messages![0];
    const snapshot = messages![1].bootstrap as Record<string, any>;
    const ready = messages![2];
    expect(started.mode).toBe("snapshot");
    expect(snapshot.viewRevision).toBe(started.targetRevision);
    expect(ready.appliedRevision).toBe(started.targetRevision);

    const mappings = await queryDO<{
      view_protocol: number;
      applied_view_revision: number;
    }>(stub, "SELECT view_protocol, applied_view_revision FROM ws_client_mapping");
    expect(mappings).toEqual([
      { view_protocol: 2, applied_view_revision: ready.appliedRevision as number },
    ]);
    ws.close();
  });

  it("resumes with a bounded contiguous delta and falls back to snapshot after a gap", async () => {
    const name = `v2-resume-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await waitForSandboxStatus(stub, "failed");
    const initial = await (
      await stub.fetch("http://internal/internal/bootstrap")
    ).json<{
      viewRevision: number;
    }>();

    const titleResponse = await stub.fetch("http://internal/internal/update-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1", title: "Revision title" }),
    });
    expect(titleResponse.status).toBe(200);

    const resumed = await openClientWs(name, {
      subscribe: true,
      viewProtocol: 2,
      resumeRevision: initial.viewRevision,
    });
    expect(resumed.messages!.map((message) => message.type)).toEqual([
      "session_sync_started",
      "session_delta",
      "session_ready",
    ]);
    expect(resumed.messages![0].mode).toBe("resume");
    expect(resumed.messages![1].revision).toBe(initial.viewRevision + 1);
    resumed.ws.close();

    await queryDO(
      stub,
      "DELETE FROM session_view_deltas WHERE revision = ?",
      initial.viewRevision + 1
    );
    const fallback = await openClientWs(name, {
      subscribe: true,
      viewProtocol: 2,
      resumeRevision: initial.viewRevision,
    });
    expect(fallback.messages![0]).toMatchObject({
      type: "session_sync_started",
      mode: "snapshot",
    });
    expect(fallback.messages!.some((message) => message.type === "session_snapshot")).toBe(true);
    fallback.ws.close();
  });

  it("dual-encodes live title changes and returns stable V2 history envelopes", async () => {
    const name = `v2-live-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await waitForSandboxStatus(stub, "failed");
    const now = Date.now();
    await seedEvents(stub, [
      {
        id: "history-old",
        type: "tool_result",
        data: JSON.stringify({
          type: "tool_result",
          sandboxId: "sandbox-1",
          timestamp: now - 1,
          messageId: "message-1",
          callId: "call-old",
          result: "old",
        }),
        createdAt: now - 1,
      },
      {
        id: "history-new",
        type: "tool_result",
        data: JSON.stringify({
          type: "tool_result",
          sandboxId: "sandbox-1",
          timestamp: now,
          messageId: "message-1",
          callId: "call-new",
          result: "new",
        }),
        createdAt: now,
      },
    ]);
    const v1 = await openClientWs(name, { subscribe: true });
    const v2 = await openClientWs(name, { subscribe: true, viewProtocol: 2, forceSnapshot: true });

    const v1Live = collectMessages(v1.ws, { until: (message) => message.type === "session_title" });
    const v2Live = collectMessages(v2.ws, { until: (message) => message.type === "session_delta" });
    const updated = await stub.fetch("http://internal/internal/update-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1", title: "Live title" }),
    });
    expect(updated.status).toBe(200);
    expect((await v1Live).at(-1)).toEqual({ type: "session_title", title: "Live title" });
    expect((await v2Live).at(-1)).toMatchObject({
      type: "session_delta",
      delta: { operations: [{ type: "state_patch", patch: { title: "Live title" } }] },
    });

    const pagePromise = collectMessages(v2.ws, {
      until: (message) => message.type === "session_history_page",
    });
    v2.ws.send(
      JSON.stringify({
        type: "fetch_history",
        cursor: { timestamp: now, id: "history-new" },
        limit: 10,
      })
    );
    const page = (await pagePromise).at(-1) as Record<string, any>;
    expect(page.type).toBe("session_history_page");
    expect(page.items).toContainEqual(
      expect.objectContaining({ eventId: "history-old", timelineSequence: expect.any(Number) })
    );
    v1.ws.close();
    v2.ws.close();
  });
});
