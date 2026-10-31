import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "./client";
import { createServer } from "./index";
import { TOOLS } from "./tools";

const TOKEN = `oi_pat_${"a".repeat(64)}`;
const BASE_URL = "https://control-plane.example.com";
const source = {
  provider: "github",
  repoOwner: "acme",
  repoName: "skills",
  requestedRef: "main",
  resolvedRef: "main",
  commitSha: "c".repeat(40),
  subdirectory: null,
  sourceSha256: "5".repeat(64),
};
const preview = {
  name: "deploy-service",
  nameAvailable: true,
  revisionSha256: "d".repeat(64),
  totalBytes: 10,
  source,
  warnings: [],
  files: [{ path: "SKILL.md" }],
};
const storedSkill = {
  skill: {
    id: "skill_1",
    name: "deploy-service",
    description: "How to deploy",
    enabled: true,
    currentRevisionId: "skillrev_2",
    revisionNumber: 2,
    source: { ...source, importedAt: 1, revisionId: "skillrev_2" },
  },
  revisionCreated: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  {
    name: "import_skill_from_git",
    args: { repo_owner: "acme", repo_name: "skills", ref: "main" },
    previewPath: "/skills/import/preview",
    mutationPath: "/skills/import",
  },
  {
    name: "update_skill_from_git",
    args: { skill_id: "skill_1", ref: "main" },
    previewPath: "/skills/skill_1/reimport/preview",
    mutationPath: "/skills/skill_1/reimport",
  },
])("$name cancellation", ({ name, args, previewPath, mutationPath }) => {
  it.each([true, false])("fences a pending write only when cancelled (%s)", async (cancel) => {
    const previewStarted = deferred<AbortSignal>();
    const previewResponse = deferred<Response>();
    const handlerSettled = deferred<void>();
    const definition = TOOLS.find((tool) => tool.name === name)!;
    const run = definition.run;
    vi.spyOn(definition, "run").mockImplementation(async (...args) => {
      try {
        return await run(...args);
      } finally {
        handlerSettled.resolve();
      }
    });

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === previewPath) {
        previewStarted.resolve(init.signal!);
        // Deliberately allow a late response after abort: the next write must
        // also check cancellation, not rely solely on fetch rejecting.
        return previewResponse.promise;
      }
      return jsonResponse(new URL(url).pathname === "/skills" ? { skills: [] } : storedSkill);
    });
    vi.stubGlobal("fetch", fetchMock);
    const server = createServer(new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN }));
    const mcpClient = new Client({ name: "cancellation-test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const sent = vi.spyOn(clientTransport, "send");
    const controller = new AbortController();

    try {
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
      // Attach the rejection handler immediately, before cancelling the call.
      const outcome = mcpClient
        .callTool({ name, arguments: args }, undefined, { signal: controller.signal })
        .then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error })
        );
      const fetchSignal = await previewStarted.promise;
      if (cancel) {
        controller.abort();
        await mcpClient.ping(); // Barrier: the SDK has processed notifications/cancelled.
        expect(sent.mock.calls.map(([message]) => message)).toContainEqual(
          expect.objectContaining({ method: "notifications/cancelled" })
        );
      }

      // Cancellation belongs to one request, not the server's shared client,
      // even while that request's application handler is still pending.
      const next = await mcpClient.callTool({ name: "list_skills", arguments: {} });
      expect(next.isError).toBeFalsy();

      previewResponse.resolve(jsonResponse(preview));
      // The SDK suppresses a cancelled response before the application handler
      // settles, so awaiting only the client call would miss the late write.
      await handlerSettled.promise;
      const result = await outcome;
      const mutations = fetchMock.mock.calls.filter(
        ([url, init]) => new URL(url).pathname === mutationPath && init.method === "POST"
      );
      expect(mutations).toHaveLength(cancel ? 0 : 1);
      expect(fetchSignal.aborted).toBe(cancel);
      if (cancel) {
        expect(result.error).toBeDefined();
      } else {
        expect(result.error).toBeUndefined();
        expect(result.result?.isError).toBeFalsy();
      }
    } finally {
      previewResponse.resolve(jsonResponse(preview));
      await mcpClient.close();
      await server.close();
    }
  });
});
