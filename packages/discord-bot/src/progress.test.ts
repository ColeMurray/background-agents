import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeStep,
  finishProgress,
  formatElapsed,
  formatStatus,
  recordStep,
  startProgress,
  stopPublication,
  PUBLICATION_STOPPED_TEXT,
} from "./progress";
import { createEnv, createKv } from "./test-helpers";

const discordFetch = vi.fn();

function calls() {
  return discordFetch.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: init.method as string,
    body: init.body ? JSON.parse(init.body) : {},
  }));
}

beforeEach(() => {
  vi.stubGlobal("fetch", discordFetch);
  discordFetch.mockImplementation(
    async () => new Response(JSON.stringify({ id: "status-1" }), { status: 200 })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("formatting", () => {
  it("formats elapsed time", () => {
    expect(formatElapsed(4_200)).toBe("4s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
  });

  it("uses shared aliases and compacts only file arguments", () => {
    expect(describeStep("Edit", { file_path: "/workspace/repo/src/components/Button.tsx" })).toBe(
      "Editing src/components/Button.tsx"
    );
    expect(describeStep("read", { filePath: "/workspace/repo/README.md" })).toBe(
      "Reading README.md"
    );
    expect(describeStep("Bash", { command: "npm run build" })).toBe("Running npm run build");
    expect(describeStep("TodoWrite", {})).toBe("Using tool: TodoWrite");
  });

  it("preserves URLs and slash-separated shell arguments", () => {
    expect(describeStep("Bash", { command: "curl https://x.test/v1/users/me" })).toBe(
      "Running curl https://x.test/v1/users/me"
    );
    expect(describeStep("Bash", { command: "echo /a/b/c/d" })).toBe("Running echo /a/b/c/d");
  });

  it("handles aliases, listing, Windows paths, and Discord markup without mangling URLs", () => {
    expect(describeStep("READ_FILE", { filepath: "C:\\repo\\src\\file.ts" })).toBe(
      "Reading C:/repo/src/file.ts"
    );
    expect(describeStep("list", { path: "/workspace/repo/src" })).toBe("Listing src");
    expect(describeStep("glob", { query: "**/*.ts" })).toBe("Finding **/*.ts");
    const command = "curl https://api.example.com/v1/users/me";
    expect(describeStep("execute_command", { cmd: command })).toBe(`Running ${command}`);
    expect(
      describeStep("bash", { command: "echo `[link](https://api.example.com/v1/users/me)`" })
    ).toBe("Running echo '[link](https://api.example.com/v1/users/me)'");
    expect(describeStep("bash", { command: "x".repeat(200) }).length).toBeLessThanOrEqual(120);
  });

  it("shows the starting line before the first step", () => {
    expect(formatStatus(0, undefined, 0)).toBe("⏳ **Working…** 0s\n-# Starting the sandbox");
  });
});

describe("progress lifecycle", () => {
  it("posts, updates, and finishes one status message", async () => {
    const env = createEnv();

    const statusMessage = await startProgress(env, "thread-1");
    expect(statusMessage).toEqual({ id: "status-1", startedAt: expect.any(Number) });
    expect(calls()[0]).toMatchObject({
      url: expect.stringContaining("/channels/thread-1/messages"),
    });

    await recordStep(env, {
      channelId: "thread-1",
      statusMessage: statusMessage!,
      tool: "Bash",
      args: { command: "npm test" },
    });
    const edit = calls().find((call) => call.method === "PATCH")!;
    expect(edit.url).toContain("/channels/thread-1/messages/status-1");
    expect(edit.body.content).toMatch(/^⏳ \*\*Working…\*\* \d+s\n-# Running npm test$/);
    expect(calls().some((call) => call.url.endsWith("/channels/thread-1/typing"))).toBe(true);

    await finishProgress(env, {
      channelId: "thread-1",
      statusMessage: statusMessage!,
      success: true,
    });
    expect(calls().at(-1)!.body.content).toMatch(/^✅ \*\*Finished\*\* in \d+s$/);
  });

  it("repairs the final text rather than publishing a step after the prompt finished", async () => {
    const env = createEnv();
    const statusMessage = { id: "status-1", startedAt: Date.now() };
    await finishProgress(env, { channelId: "thread-1", statusMessage, success: true });
    discordFetch.mockClear();

    await recordStep(env, { channelId: "thread-1", statusMessage, tool: "Bash", args: {} });
    expect(calls()).toHaveLength(1);
    expect(calls()[0].body.content).toMatch(/^✅ \*\*Finished\*\*/);
  });

  it("restores the finished text when a step edit lands after finishing", async () => {
    const env = createEnv();
    const statusMessage = { id: "status-1", startedAt: Date.now() };
    discordFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      // The step's PATCH resolves only after completion has run.
      if (init.method === "PATCH" && String(init.body).includes("Working")) {
        await finishProgress(env, { channelId: "thread-1", statusMessage, success: true });
      }
      return new Response(JSON.stringify({ id: "status-1" }), { status: 200 });
    });

    await recordStep(env, { channelId: "thread-1", statusMessage, tool: "Bash", args: {} });
    const edits = calls().filter((call) => call.method === "PATCH");
    expect(edits.at(-1)!.body.content).toMatch(/^✅ \*\*Finished\*\*/);
  });

  it("repairs a tool edit already in flight when publication is stopped", async () => {
    const kv = createKv();
    const env = createEnv({ DISCORD_KV: kv as unknown as KVNamespace });
    const statusMessage = { id: "status-1", startedAt: Date.now() };
    discordFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === "PATCH" && String(init.body).includes("Working")) {
        await stopPublication(env, { channelId: "thread-1", statusMessage });
      }
      return new Response(JSON.stringify({ id: "status-1" }));
    });
    await recordStep(env, { channelId: "thread-1", statusMessage, tool: "Bash", args: {} });
    expect(kv.put).toHaveBeenCalledWith("status-finished:status-1", PUBLICATION_STOPPED_TEXT, {
      expirationTtl: 60 * 60,
    });
    expect(
      calls()
        .filter((call) => call.method === "PATCH")
        .at(-1)!.body.content
    ).toBe(PUBLICATION_STOPPED_TEXT);
  });

  it("returns nothing and never throws when Discord fails", async () => {
    discordFetch.mockResolvedValue(new Response("down", { status: 500 }));
    await expect(startProgress(createEnv(), "thread-1")).resolves.toBeUndefined();
    await expect(
      recordStep(createEnv(), {
        channelId: "thread-1",
        statusMessage: { id: "status-1", startedAt: 0 },
        tool: "Bash",
        args: {},
      })
    ).resolves.toBeUndefined();
  });
});
