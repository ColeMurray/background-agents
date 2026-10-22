import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeStep,
  finishProgress,
  formatElapsed,
  formatStatus,
  recordStep,
  startProgress,
} from "./progress";
import { createEnv } from "./test-helpers";

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
    expect(edit.body.content).toMatch(/^⏳ \*\*Working…\*\* \d+s\n-# Ran: npm test$/);
    expect(calls().some((call) => call.url.endsWith("/channels/thread-1/typing"))).toBe(true);

    await finishProgress(env, {
      channelId: "thread-1",
      statusMessage: statusMessage!,
      success: true,
    });
    expect(calls().at(-1)!.body.content).toMatch(/^✅ \*\*Finished\*\* in \d+s$/);
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
