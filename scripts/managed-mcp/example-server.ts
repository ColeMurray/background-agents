/** Loopback-only verification server. Never deploy this fixture: /test controls impersonate humans. */
import { serve } from "@hono/node-server";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { applyMigrations } from "../../packages/control-plane/src/node/migrate";
import { createNodeSqlDatabase } from "../../packages/control-plane/src/node/sqlite-database";
import { McpServerStore } from "../../packages/control-plane/src/db/mcp-servers";
import {
  McpConnectionStore,
  connectionBinding,
} from "../../packages/control-plane/src/db/mcp-connections";
import { McpOAuthService } from "../../packages/control-plane/src/mcp/oauth";
import { generateEncryptionKey } from "../../packages/control-plane/src/auth/crypto";
import { relayMcpRequest } from "../../packages/control-plane/src/mcp/relay";
import { McpError, mcpErrorResponse } from "../../packages/control-plane/src/mcp/errors";
import { ManagedMcpGatewayFixture } from "../../packages/control-plane/test/fixtures/managed-mcp-gateway";

const raw = new DatabaseSync(":memory:");
applyMigrations(raw, resolve("terraform/d1/migrations"));
const db = createNodeSqlDatabase(raw);
const gateway = new ManagedMcpGatewayFixture();
const key = generateEncryptionKey();
const registry = new McpServerStore(db, key);
const definition = await registry.create({
  name: "example",
  type: "remote",
  url: `${gateway.origin}/mcp`,
  enabled: true,
  managedRouting: true,
  authMode: "user_oauth",
  oauth: { issuer: gateway.origin, resource: `${gateway.origin}/mcp` },
});
const store = new McpConnectionStore(db, key);
const oauth = new McpOAuthService(store, (request) => gateway.fetch(request));
for (const owner of ["reader", "operator"]) {
  const now = Date.now();
  await db
    .prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)")
    .bind(owner, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO auth_sessions (id,userId,token,createdAt,updatedAt,expiresAt) VALUES (?,?,?,?,?,?)"
    )
    .bind(owner, owner, `fixture-${owner}`, now, now, now + 3600000)
    .run();
  const url = new URL(
    await oauth.start(owner, owner, definition, "https://app.fixture.test/callback")
  );
  url.searchParams.set("fixture_user", owner);
  const consent = await gateway.fetch(new Request(url));
  const callback = new URL(consent.headers.get("location")!);
  await oauth.callback(owner, owner, {
    code: callback.searchParams.get("code")!,
    state: callback.searchParams.get("state")!,
    iss: gateway.origin,
  });
}
let owner = "reader",
  revision = 1,
  active = true;
let localOrigin = "";
const server = serve(
  {
    hostname: "127.0.0.1",
    port: Number(process.env.MCP_FIXTURE_PORT ?? 17881),
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/test/context" && request.method === "POST") {
        const data = (await request.json()) as {
          owner?: string;
          active?: boolean;
          loseMutationResponse?: boolean;
        };
        if (data.owner && !["reader", "operator"].includes(data.owner))
          return new Response(null, { status: 400 });
        if (data.owner) owner = data.owner;
        active = data.active ?? true;
        revision++;
        gateway.loseMutationResponse = data.loseMutationResponse ?? false;
        return Response.json({ owner, revision, active });
      }
      if (url.pathname === "/test/trace")
        return Response.json({
          requests: gateway.requests,
          mutations: gateway.mutationCount,
          refreshes: gateway.refreshCount,
          sessions: [...gateway.sessions].map(([id, user]) => ({ id, user })),
        });
      if (url.pathname.startsWith("/upstream/")) {
        return gateway.fetch(new Request(`${gateway.origin}/${url.pathname.slice(10)}`, request));
      }
      if (url.pathname !== "/sessions/local/mcp/example")
        return new Response(null, { status: 404 });
      try {
        if (request.headers.get("authorization") !== "Bearer sandbox-fixture")
          throw new McpError("mcp_denied", 401);
        if (!active) throw new McpError("mcp_execution_inactive");
        const captured = { owner, revision };
        const binding = connectionBinding((await store.get(captured.owner, definition.id))!);
        const credential = await oauth.credential(binding);
        return await relayMcpRequest(request, {
          target: definition.url!,
          upstreamHeaders: { Authorization: `Bearer ${credential}` },
          personal: true,
          revalidate: async () => {
            await store.require(binding);
            if (!active || owner !== captured.owner || revision !== captured.revision)
              throw new McpError("mcp_context_changed", 409);
          },
          // Test-only transport translation. Production destination validation remains HTTPS-only.
          fetcher: (r) => fetch(new Request(`${localOrigin}/upstream/mcp`, r)),
        });
      } catch (error) {
        return mcpErrorResponse(error);
      }
    },
  },
  (info) => {
    localOrigin = `http://127.0.0.1:${info.port}`;
    process.stdout.write(
      JSON.stringify({ origin: localOrigin, proxy: `${localOrigin}/sessions/local/mcp/example` }) +
        "\n"
    );
  }
);
process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
