import { createPublicKey, verify } from "node:crypto";

export const FIXTURE_REPOSITORY = {
  id: 90001,
  name: "preview-app",
  full_name: "preview-org/preview-app",
  description: "Local authenticated preview fixture",
  private: true,
  archived: false,
  default_branch: "main",
  language: "TypeScript",
  topics: [],
  owner: { login: "preview-org" },
};

/** Exact upstream fixtures and a fail-closed fetch guard, not an OS network sandbox. */
export function installGitHubFixture(options: {
  origins: readonly string[];
  appId: string;
  installationId: string;
  privateKey: string;
  token: string;
}) {
  const nativeFetch = globalThis.fetch;
  const unexpectedRequests: string[] = [];
  const requests: string[] = [];
  const publicKey = createPublicKey(options.privateKey);
  const reject = (request: Request): never => {
    const url = new URL(request.url);
    const description = `${request.method} ${url.origin}${url.pathname}`;
    unexpectedRequests.push(description);
    throw new Error(`fixture: unexpected upstream request ${description}`);
  };
  const guardedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (options.origins.includes(url.origin)) {
      // Never follow redirects to arbitrary localhost services or live upstreams.
      // Pass the caller's signal directly: Request cloning can lose a timeout's
      // lifetime through weak signal links on Node 22, even while fetch is pending.
      const signal =
        init?.signal === undefined && input instanceof Request ? input.signal : init?.signal;
      const response = await nativeFetch(request, { redirect: "manual", signal });
      if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
        await response.body?.cancel();
        return reject(request);
      }
      return response;
    }
    if (url.origin !== "https://api.github.com") return reject(request);
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const body = await request.text();
    const auth = request.headers.get("authorization") ?? "";
    if (
      request.method === "POST" &&
      url.pathname === `/app/installations/${options.installationId}/access_tokens` &&
      !url.search &&
      !body
    ) {
      const parts = auth.replace(/^Bearer /, "").split(".");
      try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
        if (
          parts.length !== 3 ||
          header.alg !== "RS256" ||
          String(payload.iss) !== options.appId ||
          payload.exp <= Date.now() / 1000 ||
          !verify(
            "RSA-SHA256",
            Buffer.from(parts.slice(0, 2).join(".")),
            publicKey,
            Buffer.from(parts[2], "base64url")
          )
        )
          return reject(request);
      } catch {
        return reject(request);
      }
      return Response.json({
        token: options.token,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (request.method !== "GET" || body || auth !== `Bearer ${options.token}`)
      return reject(request);
    if (url.pathname === "/installation/repositories" && url.search === "?per_page=100&page=1") {
      return Response.json({ total_count: 1, repositories: [FIXTURE_REPOSITORY] });
    }
    if (url.pathname === `/repos/${FIXTURE_REPOSITORY.full_name}` && !url.search)
      return Response.json(FIXTURE_REPOSITORY);
    if (url.pathname === "/repos/preview-org/inaccessible" && !url.search)
      return Response.json({ message: "Not Found" }, { status: 404 });
    if (
      url.pathname === `/repos/${FIXTURE_REPOSITORY.full_name}/branches` &&
      url.search === "?per_page=100&page=1"
    ) {
      return Response.json([
        { name: "main", commit: { sha: "a".repeat(40) }, protected: false },
        { name: "feature/preview", commit: { sha: "b".repeat(40) }, protected: false },
      ]);
    }
    return reject(request);
  };
  globalThis.fetch = guardedFetch;
  return {
    unexpectedRequests,
    requests,
    close() {
      if (globalThis.fetch !== guardedFetch)
        throw new Error("fixture: fetch ownership changed before cleanup");
      globalThis.fetch = nativeFetch;
    },
  };
}
