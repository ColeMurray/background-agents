import { SessionMcpContext } from "../../src/session/mcp-context";
import { SessionCoreRepository } from "../../src/session/session-core-repository";
import { runInSessionDO, componentsOf, type SessionDOInternals } from "./session-do-access";
import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { serviceFetch, initNamedSession, seedSandboxAuth, queryDO, openSandboxWs } from "./helpers";
import { cleanD1Tables } from "./cleanup";
import { McpServerStore } from "../../src/db/mcp-servers";
import { McpConnectionStore, connectionBinding } from "../../src/db/mcp-connections";
import { McpOAuthService } from "../../src/mcp/oauth";
import { createMcpDestinationPolicy } from "../../src/mcp/authorization";
import { SessionInternalPaths } from "../../src/session/contracts";
const alice = "11111111111111111111111111111111";
const bob = "22222222222222222222222222222222";
const token = "test-current-sandbox";
const origin = "https://mcp.fixture.test";
async function fixture(mode: "none" | "service_credentials" | "user_oauth" = "user_oauth") {
  await serviceFetch("https://test.local/mcp-connections");
  const registry = new McpServerStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
  const server = await registry.create({
    name: "example",
    type: "remote",
    url: `${origin}/mcp`,
    enabled: true,
    managedRouting: true,
    authMode: mode,
    ...(mode === "user_oauth" ? { oauth: { issuer: origin, resource: `${origin}/mcp` } } : {}),
  });
  const sessionName = `mcp-${crypto.randomUUID()}`;
  const { stub } = await initNamedSession(sessionName, { canonicalUserId: alice });
  await seedSandboxAuth(stub, { authToken: token, sandboxId: "allocation-1" });
  await queryDO(
    stub,
    "UPDATE sandbox SET mcp_runtime_version = 1, mcp_servers = ?",
    JSON.stringify([
      { id: server.id, name: server.name, authMode: mode, authRevision: server.authRevision },
    ])
  );
  const store = new McpConnectionStore(env.DB, env.TOKEN_ENCRYPTION_KEY!);
  const oauth = new McpOAuthService(store, createMcpDestinationPolicy(env));
  let binding;
  if (mode === "user_oauth") {
    const url = await oauth.start(
      alice,
      "test-browser-session",
      server,
      "https://app.test.local/api/mcp-connections/oauth/callback"
    );
    const consent = await fetch(url, { redirect: "manual" });
    const callback = new URL(consent.headers.get("location")!);
    await oauth.callback(alice, "test-browser-session", {
      code: callback.searchParams.get("code")!,
      state: callback.searchParams.get("state")!,
      iss: origin,
    });
    binding = connectionBinding((await store.get(alice, server.id))!);
    await queryDO(
      stub,
      `INSERT INTO messages (id, author_id, content, source, status, created_at, admitted_canonical_user_id, mcp_eligible, mcp_revision, mcp_closed, mcp_context)
      SELECT 'alice-message', id, 'read', 'web', 'processing', ?, ?, 1, 1, 0, ? FROM participants LIMIT 1`,
      Date.now(),
      alice,
      JSON.stringify({
        sandboxId: "allocation-1",
        sandboxCreatedAt: (
          await queryDO<{ created_at: number }>(stub, "SELECT created_at FROM sandbox")
        )[0].created_at,
        bindings: [binding],
      })
    );
  }
  const context = (input: object, bearer = token) =>
    stub.fetch(`https://internal${SessionInternalPaths.mcpContext}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: server.id, leaseId: crypto.randomUUID(), ...input }),
    });
  const proxy = (body: object, bearer = token) =>
    SELF.fetch(`https://test.local/sessions/${sessionName}/mcp/${server.id}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
  return { stub, server, registry, store, binding, context, proxy, sessionName };
}
describe("managed MCP actual sandbox route + session authority", () => {
  beforeEach(cleanD1Tables);
  it("passes initialize through the authenticated route without exposing either credential", async () => {
    const f = await fixture();
    const response = await f.proxy({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(response.status).toBe(200);
    expect(response.headers.get("Mcp-Session-Id")).toBeTruthy();
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.text();
    expect(body).toContain("managed-proxy-fixture");
    expect(body).not.toContain(token);
    expect((await f.proxy({}, "old-sandbox-token")).status).not.toBe(200);
  });
  it("rejects a captured Alice request after queue transition, closure, or replacement", async () => {
    const f = await fixture();
    const leaseId = crypto.randomUUID();
    const first = await f.context({ leaseId });
    expect(first.status).toBe(200);
    const expected = await first.json();
    await queryDO(f.stub, "UPDATE messages SET mcp_closed = 1 WHERE id = 'alice-message'");
    expect((await f.context({ leaseId, expected })).status).toBe(403);
    await queryDO(
      f.stub,
      "UPDATE messages SET mcp_closed = 0, mcp_revision = 2, admitted_canonical_user_id = ? WHERE id = 'alice-message'",
      bob
    );
    expect((await f.context({ leaseId, expected })).status).toBe(409);
    await queryDO(f.stub, "UPDATE sandbox SET modal_sandbox_id = 'allocation-2'");
    expect((await f.context({})).status).toBe(409);
  });
  it("fails closed for runtime downgrade, disconnect, removed access, and registry revision", async () => {
    const f = await fixture();
    await queryDO(f.stub, "UPDATE sandbox SET mcp_runtime_version = 0");
    expect((await f.context({})).status).toBe(403);
    await queryDO(f.stub, "UPDATE sandbox SET mcp_runtime_version = 1");
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
      .bind(Date.now(), alice)
      .run();
    expect((await f.proxy({})).status).toBe(403);
    await env.DB.prepare("UPDATE users SET suspended_at = NULL WHERE id = ?").bind(alice).run();
    await f.store.disconnect(alice, f.server.id);
    expect((await f.proxy({})).status).toBe(409);
    await f.registry.update(f.server.id, { url: `${origin}/changed` });
    expect((await f.proxy({})).status).toBe(409);
  });
  it("preserves an existing launch binding after an unchanged editor save", async () => {
    const f = await fixture();
    const initialized = await f.proxy({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(initialized.status).toBe(200);
    await initialized.arrayBuffer();
    await f.registry.update(f.server.id, {
      name: f.server.name,
      type: "remote",
      url: f.server.url,
      enabled: f.server.enabled,
      repoScopes: f.server.repoScopes,
      authMode: f.server.authMode,
      managedRouting: f.server.managedRouting,
      oauth: f.server.oauth,
      headers: {},
    });
    const accepted = await f.proxy({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    expect(accepted.status).toBe(200);
    await accepted.arrayBuffer();
  });
  it("public mode needs no human and admission enforces eight live leases until release", async () => {
    const f = await fixture("none");
    await queryDO(f.stub, "UPDATE sandbox SET status = 'spawning'");
    const leaseId = crypto.randomUUID();
    expect((await f.context({ leaseId })).status).toBe(200);
    for (let i = 0; i < 7; i++) expect((await f.context({})).status).toBe(200);
    expect((await f.context({})).status).toBe(429);
    expect((await f.context({ leaseId, release: true })).status).toBe(200);
    expect((await f.context({})).status).toBe(200);
  });
  it.each(
    (["none", "service_credentials", "user_oauth"] as const).flatMap((mode) =>
      (["archived", "cancelled"] as const).map((status) => ({ mode, status }))
    )
  )(
    "rejects new and captured $mode calls after the session is $status",
    async ({ mode, status }) => {
      const f = await fixture(mode);
      const leaseId = crypto.randomUUID();
      const captured = await f.context({ leaseId });
      expect(captured.status).toBe(200);
      const expected = await captured.json();
      // An expired warm draft can retain a ready sandbox and valid token.
      await queryDO(f.stub, "UPDATE session SET status = ?", status);

      const denied = await f.proxy({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "mcp_execution_inactive" });
      expect((await f.context({ leaseId, expected })).status).toBe(403);
      expect((await f.context({ leaseId, release: true })).status).toBe(200);
      expect(
        await queryDO(f.stub, "SELECT id FROM mcp_proxy_leases WHERE id = ?", leaseId)
      ).toEqual([]);
    }
  );
  it("rejects uploads over the concurrency budget before body validation", async () => {
    const f = await fixture("none");
    for (let i = 0; i < 8; i++) expect((await f.context({})).status).toBe(200);
    // Body-first ordering would return 413 instead of admission's 429. Use a
    // complete upload: SELF's in-process transport reports an unhandled pipe
    // rejection when a worker rejects an intentionally unfinished upload.
    const response = await SELF.fetch(
      `https://test.local/sessions/${f.sessionName}/mcp/${f.server.id}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "x".repeat(1024 * 1024 + 1),
      }
    );
    expect(response.status).toBe(429);
    await response.arrayBuffer();
  });
  it("prepares from retained author and rejects a claim changed across credential lookups", async () => {
    const f = await fixture();
    await queryDO(f.stub, "UPDATE participants SET canonical_user_id = ?", bob);
    await runInSessionDO(f.stub, async (instance, state) => {
      const context = new SessionMcpContext(
        state.storage.sql,
        env.DB,
        (instance as unknown as SessionDOInternals).appEnv,
        new SessionCoreRepository(state.storage.sql, (run) => state.storage.transactionSync(run)),
        componentsOf(instance).sandboxRepository
      );
      const first = await context.prepare("alice-message");
      expect(first.servers).toEqual(["example"]);
      const pending = context.prepare("alice-message");
      state.storage.sql.exec(
        "UPDATE messages SET mcp_revision = mcp_revision + 1, mcp_context = NULL"
      );
      await expect(pending).rejects.toMatchObject({ code: "mcp_context_changed" });
      state.storage.sql.exec("UPDATE messages SET mcp_eligible = 0");
      const automation = await context.prepare("alice-message");
      expect(automation.servers).toEqual([]);
      expect(automation.unavailable).toEqual([{ name: "example", code: "mcp_execution_inactive" }]);
    });
  });
  it("preserves a healthy bridge across transport reconnect and turn cleanup", async () => {
    const f = await fixture();
    const allocation = await queryDO(f.stub, "SELECT modal_sandbox_id, created_at FROM sandbox");
    const version = async () =>
      (
        await queryDO<{ mcp_runtime_version: number }>(
          f.stub,
          "SELECT mcp_runtime_version FROM sandbox"
        )
      )[0].mcp_runtime_version;
    let readyCount = 0;
    const bridgeInstanceId = crypto.randomUUID();
    async function reconnect() {
      const { ws, response } = await openSandboxWs(f.sessionName, {
        authToken: token,
        sandboxId: "allocation-1",
      });
      expect(response.status).toBe(101);
      ws!.accept();
      try {
        ws!.send(
          JSON.stringify({
            type: "ready",
            sandboxId: "allocation-1",
            timestamp: Date.now(),
            managedMcpVersion: 1,
            bridgeInstanceId,
          })
        );
        readyCount++;
        await expect
          .poll(
            async () =>
              (
                await queryDO<{ count: number }>(
                  f.stub,
                  "SELECT count(*) AS count FROM events WHERE type = 'ready'"
                )
              )[0].count
          )
          .toBe(readyCount);
      } finally {
        const closed = new Promise<void>((resolve) =>
          ws!.addEventListener("close", () => resolve(), { once: true })
        );
        ws!.close(1000, "Review transport reconnect");
        await closed;
      }
    }

    // Control: an idle ready/reconnect does not disable the allocation.
    await queryDO(f.stub, "UPDATE messages SET status = 'completed'");
    await reconnect();
    expect(await version()).toBe(1);

    // The same live bridge retains ownership of the running turn and its cleanup.
    await queryDO(f.stub, "UPDATE messages SET status = 'processing'");
    expect((await f.context({})).status).toBe(200);
    await reconnect();
    expect(await version()).toBe(1);
    expect((await f.context({})).status).toBe(200);

    // Successful cleanup leaves the allocation available for the next turn.
    const closed = await f.stub.fetch(`https://internal${SessionInternalPaths.mcpClose}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "alice-message", revision: 1 }),
    });
    expect(closed.status).toBe(200);
    await queryDO(f.stub, "UPDATE messages SET status = 'completed'");
    await reconnect();
    expect(await version()).toBe(1);
    expect(await queryDO(f.stub, "SELECT modal_sandbox_id, created_at FROM sandbox")).toEqual(
      allocation
    );
    await queryDO(
      f.stub,
      "UPDATE messages SET status = 'processing', mcp_revision = 2, mcp_closed = 0"
    );
    expect((await f.context({})).status).toBe(200);
  });
  it.each(
    ["processing", "closed", "stopping"].flatMap((phase) =>
      ["replacement", "legacy", "uncertain"].map((reason) => ({ phase, reason }))
    )
  )("fences $reason readiness during a $phase prepared turn", async ({ phase, reason }) => {
    const f = await fixture();
    const bridgeInstanceId = crypto.randomUUID();
    await queryDO(f.stub, "UPDATE sandbox SET mcp_bridge_instance_id = ?", bridgeInstanceId);
    await queryDO(f.stub, "UPDATE messages SET mcp_closed = ?", phase === "processing" ? 0 : 1);
    if (phase === "stopping")
      await queryDO(
        f.stub,
        "UPDATE messages SET status = 'failed', stop_confirmation_deadline = ?",
        Date.now() + 60_000
      );
    const { ws, response } = await openSandboxWs(f.sessionName, {
      authToken: token,
      sandboxId: "allocation-1",
    });
    expect(response.status).toBe(101);
    ws!.accept();
    try {
      ws!.send(
        JSON.stringify({
          type: "ready",
          sandboxId: "allocation-1",
          timestamp: Date.now(),
          ...(reason === "uncertain" ? {} : { managedMcpVersion: 1 }),
          ...(reason === "legacy"
            ? {}
            : {
                bridgeInstanceId: reason === "replacement" ? crypto.randomUUID() : bridgeInstanceId,
              }),
        })
      );
      await expect
        .poll(
          async () =>
            (
              await queryDO<{ mcp_runtime_version: number }>(
                f.stub,
                "SELECT mcp_runtime_version FROM sandbox"
              )
            )[0].mcp_runtime_version
        )
        .toBe(-1);
    } finally {
      const closed = new Promise<void>((resolve) =>
        ws!.addEventListener("close", () => resolve(), { once: true })
      );
      ws!.close(1000, "Review regression complete");
      await closed;
    }
    await runInSessionDO(f.stub, async (instance, state) => {
      const context = new SessionMcpContext(
        state.storage.sql,
        env.DB,
        (instance as unknown as SessionDOInternals).appEnv,
        new SessionCoreRepository(state.storage.sql, (run) => state.storage.transactionSync(run)),
        componentsOf(instance).sandboxRepository
      );
      // Neither another ready nor a downgrade/upgrade can clear the fence.
      context.recordRuntimeVersion(0);
      context.recordRuntimeVersion(1, bridgeInstanceId);
      expect(
        state.storage.sql.exec("SELECT mcp_runtime_version FROM sandbox").one().mcp_runtime_version
      ).toBe(-1);
    });
    const denied = await f.context({});
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "mcp_runtime_restart_required" });
  });
  it("retains explicit cleanup poison across idle bridge restarts until a fresh allocation", async () => {
    const f = await fixture();
    await queryDO(f.stub, "UPDATE messages SET status = 'completed'");
    await runInSessionDO(f.stub, async (instance, state) => {
      const context = new SessionMcpContext(
        state.storage.sql,
        env.DB,
        (instance as unknown as SessionDOInternals).appEnv,
        new SessionCoreRepository(state.storage.sql, (run) => state.storage.transactionSync(run)),
        componentsOf(instance).sandboxRepository
      );
      const version = () =>
        state.storage.sql.exec("SELECT mcp_runtime_version FROM sandbox").one().mcp_runtime_version;
      context.recordRuntimeVersion(1);
      expect(version()).toBe(1); // Clean, idle reconnect is still supported.
      context.disableRuntime();
      context.recordRuntimeVersion(0);
      context.recordRuntimeVersion(1);
      expect(version()).toBe(-1);
      state.storage.sql.exec(
        "UPDATE sandbox SET modal_sandbox_id = 'allocation-2', created_at = created_at + 1"
      );
      context.recordLaunch([]);
      context.recordRuntimeVersion(1);
      expect(version()).toBe(1);
    });
  });
  it("browser routes bind callbacks and disconnect to the authenticated owner, not body selectors", async () => {
    const f = await fixture();
    const start = await serviceFetch(`https://test.local/mcp-connections/${f.server.id}/connect`, {
      method: "POST",
      body: JSON.stringify({ canonicalUserId: bob }),
    });
    expect(start.status).toBe(200);
    const { authorizationUrl } = await start.json<{ authorizationUrl: string }>();
    const consent = await fetch(authorizationUrl, { redirect: "manual" });
    const callback = new URL(consent.headers.get("location")!);
    const body = JSON.stringify({
      code: callback.searchParams.get("code"),
      state: callback.searchParams.get("state"),
      iss: origin,
    });
    const wrongOwner = await serviceFetch("https://test.local/mcp-connections/oauth/callback", {
      method: "POST",
      body,
      as: { userId: bob, role: "member" },
    });
    expect(wrongOwner.status).toBe(403);
    const redeemed = await serviceFetch("https://test.local/mcp-connections/oauth/callback", {
      method: "POST",
      body,
    });
    expect(redeemed.status).toBe(200);
    expect(
      (
        await serviceFetch("https://test.local/mcp-connections/oauth/callback", {
          method: "POST",
          body,
        })
      ).status
    ).toBe(403);
    const listed = await serviceFetch("https://test.local/mcp-connections");
    const metadata = await listed.text();
    expect(metadata).toContain('"connected"');
    expect(metadata).not.toMatch(/encrypted_payload|refreshToken|accessToken|token_endpoint/);
    await serviceFetch(`https://test.local/mcp-connections/${f.server.id}`, {
      method: "DELETE",
      as: { userId: bob, role: "member" },
    });
    expect((await f.store.get(alice, f.server.id))?.status).toBe("connected");
  });

  it("self-disconnect clears an abandoned OAuth flow and releases definition deletion", async () => {
    const f = await fixture();
    const started = await serviceFetch(
      `https://test.local/mcp-connections/${f.server.id}/connect`,
      {
        method: "POST",
      }
    );
    expect(started.status).toBe(200);
    const { authorizationUrl } = await started.json<{ authorizationUrl: string }>();
    const state = new URL(authorizationUrl).searchParams.get("state");
    // The browser leaves consent without returning a code, then the transaction expires.
    await env.DB.prepare("UPDATE mcp_oauth_transactions SET expires_at = 0 WHERE owner_id = ?")
      .bind(alice)
      .run();
    // Abandoning a reconnect keeps the grant Alice already had.
    const listed = await serviceFetch("https://test.local/mcp-connections");
    expect(await listed.json()).toMatchObject({
      connections: [{ serverId: f.server.id, status: "connected" }],
    });
    await expect(f.registry.delete(f.server.id)).rejects.toThrow("disconnect");
    const disconnected = await serviceFetch(`https://test.local/mcp-connections/${f.server.id}`, {
      method: "DELETE",
    });
    expect(disconnected.status).toBe(200);
    const lateCallback = await serviceFetch("https://test.local/mcp-connections/oauth/callback", {
      method: "POST",
      body: JSON.stringify({ state, code: "abandoned-code" }),
    });
    expect(lateCallback.status).toBe(403);
    expect(await f.registry.delete(f.server.id)).toBe(true);
  });

  it("never forwards or recaptures Bob when Alice's refresh overlaps a queue transition", async () => {
    const f = await fixture();
    const row = (await f.store.get(alice, f.server.id))!;
    const credential = await f.store.decrypt(row);
    await f.store.claimRefresh(row, "expire", Date.now());
    await f.store.publishRefresh(row, "expire", { ...credential, expiresAt: 0 });
    const before = await (await fetch(`${origin}/__fixture/status`)).json<{ requests: number }>();
    await (await fetch(`${origin}/__fixture/pause`)).arrayBuffer();
    const pending = f.proxy({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    try {
      let entered = false;
      for (let i = 0; i < 100; i++) {
        const status = await (
          await fetch(`${origin}/__fixture/status`)
        ).json<{ entered: boolean }>();
        if (status.entered) {
          entered = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(entered).toBe(true);
      await queryDO(
        f.stub,
        "UPDATE messages SET admitted_canonical_user_id = ?, mcp_revision = mcp_revision + 1 WHERE id = 'alice-message'",
        bob
      );
    } finally {
      await (await fetch(`${origin}/__fixture/release`)).arrayBuffer();
    }
    const response = await pending;
    expect(response.status).toBe(409);
    await response.arrayBuffer();
    const after = await (await fetch(`${origin}/__fixture/status`)).json<{ requests: number }>();
    expect(after.requests).toBe(before.requests);
  });
});
