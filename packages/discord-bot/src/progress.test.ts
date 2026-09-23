import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeStep,
  finishProgress,
  formatElapsed,
  formatStatus,
  recordStep,
  startProgress,
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

  it("describes steps for both harness spellings and shortens sandbox paths", () => {
    expect(describeStep("Edit", { file_path: "/workspace/repo/src/components/Button.tsx" })).toBe(
      "Edited …/components/Button.tsx"
    );
    expect(describeStep("read", { filePath: "/workspace/repo/README.md" })).toBe(
      "Read …/repo/README.md"
    );
    expect(describeStep("Bash", { command: "npm run build" })).toBe("Ran: npm run build");
    expect(describeStep("TodoWrite", {})).toBe("Used TodoWrite");
  });

  it("shows the starting line before the first step", () => {
    const text = formatStatus({ messageId: "m", startedAt: 0, recentSteps: [] }, 0);
    expect(text).toBe("⏳ **Working…** 0s\n-# Starting the sandbox");
  });
});

describe("progress lifecycle", () => {
  it("posts, updates, and finishes one status message", async () => {
    const kv = createKv();
    const env = createEnv({ DISCORD_KV: kv as unknown as KVNamespace });

    await startProgress(env, "s1", "thread-1");
    for (let i = 0; i < 7; i++) {
      await recordStep(env, {
        sessionId: "s1",
        channelId: "thread-1",
        tool: "Bash",
        args: { command: `step ${i}` },
      });
    }

    const record = JSON.parse(kv.store.get("status:s1:thread-1")!);
    expect(record.recentSteps).toEqual(
      ["step 2", "step 3", "step 4", "step 5", "step 6"].map((c) => `Ran: ${c}`)
    );

    const lastEdit = calls()
      .filter((call) => call.method === "PATCH")
      .at(-1)!;
    expect(lastEdit.url).toContain("/channels/thread-1/messages/status-1");
    expect(lastEdit.body.content).toContain("-# Ran: step 6");
    expect(calls().some((call) => call.url.endsWith("/channels/thread-1/typing"))).toBe(true);

    await finishProgress(env, { sessionId: "s1", channelId: "thread-1", success: true });
    expect(kv.store.has("status:s1:thread-1")).toBe(false);
    expect(calls().at(-1)!.body.content).toMatch(/^✅ \*\*Finished\*\* in \d+s$/);
  });

  it("ignores steps for tasks without a status message", async () => {
    await recordStep(createEnv(), {
      sessionId: "s1",
      channelId: "thread-1",
      tool: "Bash",
      args: {},
    });
    expect(discordFetch).not.toHaveBeenCalled();
  });

  it("never throws when Discord fails", async () => {
    discordFetch.mockResolvedValue(new Response("down", { status: 500 }));
    await expect(startProgress(createEnv(), "s1", "thread-1")).resolves.toBeUndefined();
  });
});
