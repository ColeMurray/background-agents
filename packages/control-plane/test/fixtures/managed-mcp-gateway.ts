/** Controlled OAuth + Streamable HTTP fixture. Never used by production code. */
export class ManagedMcpGatewayFixture {
  readonly clients = new Map<string, string>();
  readonly codes = new Map<
    string,
    { client: string; redirect: string; challenge: string; user: string }
  >();
  readonly access = new Map<string, string>();
  readonly refresh = new Map<string, { user: string; client: string }>();
  readonly sessions = new Map<string, string>();
  readonly requests: { method: string; user: string; session: string | null; rpc?: string }[] = [];
  refreshCount = 0;
  mutationCount = 0;
  tokenLifetimeSeconds = 3600;
  /** Pause an exchange after its remote effect, or lose its response. */
  afterTokenExchange?: () => Promise<void>;
  loseMutationResponse = false;

  constructor(readonly origin = "https://mcp.fixture.test") {}

  private tokens(user: string, client: string) {
    const access_token = crypto.randomUUID();
    const refresh_token = crypto.randomUUID();
    this.access.set(access_token, user);
    this.refresh.set(refresh_token, { user, client });
    return {
      access_token,
      refresh_token,
      token_type: "Bearer",
      expires_in: this.tokenLifetimeSeconds,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== this.origin) throw new Error("Fixture request outside registered origin");
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return Response.json({
        resource: `${this.origin}/mcp`,
        authorization_servers: [this.origin],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/authorize`,
        token_endpoint: `${this.origin}/token`,
        registration_endpoint: `${this.origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const body = (await request.json()) as {
        redirect_uris: string[];
        token_endpoint_auth_method: string;
      };
      if (body.token_endpoint_auth_method !== "none" || body.redirect_uris.length !== 1) {
        return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
      }
      const client_id = crypto.randomUUID();
      this.clients.set(client_id, body.redirect_uris[0]);
      return Response.json(
        { client_id, redirect_uris: body.redirect_uris, token_endpoint_auth_method: "none" },
        { status: 201 }
      );
    }
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      const client = p.get("client_id") ?? "";
      const redirect = p.get("redirect_uri") ?? "";
      // Fixture-only human selection; real deployments must authenticate the human upstream.
      const user = p.get("fixture_user") ?? "reader";
      if (
        this.clients.get(client) !== redirect ||
        p.get("resource") !== `${this.origin}/mcp` ||
        p.get("code_challenge_method") !== "S256" ||
        !p.get("code_challenge") ||
        !["reader", "operator"].includes(user)
      ) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      const code = crypto.randomUUID();
      this.codes.set(code, { client, redirect, challenge: p.get("code_challenge")!, user });
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", p.get("state") ?? "");
      callback.searchParams.set("iss", this.origin);
      return Response.redirect(callback.toString(), 302);
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const body = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
      if (body.get("resource") !== `${this.origin}/mcp`) return this.invalidGrant();
      let user: string | undefined;
      if (body.get("grant_type") === "authorization_code") {
        const code = body.get("code") ?? "";
        const pending = this.codes.get(code);
        this.codes.delete(code);
        const challenge = await pkceChallenge(body.get("code_verifier") ?? "");
        if (
          pending?.client !== body.get("client_id") ||
          pending.redirect !== body.get("redirect_uri") ||
          pending.challenge !== challenge
        ) {
          return this.invalidGrant();
        }
        user = pending.user;
      } else if (body.get("grant_type") === "refresh_token") {
        const token = body.get("refresh_token") ?? "";
        const grant = this.refresh.get(token);
        if (grant?.client !== body.get("client_id")) return this.invalidGrant();
        user = grant?.user;
        this.refresh.delete(token);
        this.refreshCount += 1;
      }
      if (!user) return this.invalidGrant();
      const tokens = this.tokens(user, body.get("client_id")!);
      await this.afterTokenExchange?.();
      return Response.json(tokens);
    }
    if (url.pathname !== "/mcp") return new Response(null, { status: 404 });
    const user = this.access.get(
      request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? ""
    );
    if (!user)
      return Response.json(
        { error: "invalid_token" },
        {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        }
      );
    const session = request.headers.get("Mcp-Session-Id");
    const trace: { method: string; user: string; session: string | null; rpc?: string } = {
      method: request.method,
      user,
      session,
    };
    this.requests.push(trace);
    if (session && this.sessions.get(session) !== user) return new Response(null, { status: 404 });
    if (request.method === "DELETE") {
      if (session) this.sessions.delete(session);
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n'
            )
          );
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    const rpc = (await request.json()) as {
      id?: number;
      method: string;
      params?: { name?: string };
    };
    trace.rpc = rpc.method;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    const headers = new Headers({
      "Content-Type": "application/json",
      "Set-Cookie": "fixture=private",
      "Cache-Control": "public",
    });
    if (rpc.method === "initialize") {
      const id = crypto.randomUUID();
      this.sessions.set(id, user);
      headers.set("Mcp-Session-Id", id);
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "managed-proxy-fixture", version: "1" },
      };
    } else if (!session) return new Response(null, { status: 400 });
    else if (rpc.method === "tools/list") {
      result = {
        tools: [
          {
            name: "read",
            description: `Read as ${user}`,
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "write",
            description: "Controlled mutation",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    } else if (rpc.method === "tools/call") {
      const denied = rpc.params?.name === "write" && user !== "operator";
      if (rpc.params?.name === "write" && !denied) {
        this.mutationCount += 1;
        if (this.loseMutationResponse) throw new Error("Fixture lost response after mutation");
      }
      result = {
        isError: denied,
        content: [{ type: "text", text: denied ? "Permission denied" : `Executed as ${user}` }],
      };
    } else
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: "Method not found" },
      });
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result }, { headers });
  }

  private invalidGrant() {
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
