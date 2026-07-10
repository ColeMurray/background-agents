import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatToolStatus,
  normalizeStatusText,
  setAssistantThreadStatus,
  truncateStatusPart,
} from "./activity-status";

describe("formatToolStatus", () => {
  it.each([
    ["Read", { file_path: "src/auth.ts" }, "Reading src/auth.ts"],
    ["read", { path: "auth.ts" }, "Reading auth.ts"],
    ["read", { filePath: "src/opencode.ts" }, "Reading src/opencode.ts"],
    [
      "read",
      {
        filePath:
          "/workspace/background-agents/packages/control-plane/src/session/durable-object.ts",
      },
      "Reading src/session/durable-object.ts",
    ],
    ["read_file", { filepath: "lib/auth.ts" }, "Reading lib/auth.ts"],
    ["Edit", { file: "src/handler.ts" }, "Editing src/handler.ts"],
    ["edit", { filePath: "src/handler.ts" }, "Editing src/handler.ts"],
    ["edit_file", { path: "handler.ts" }, "Editing handler.ts"],
    ["Write", { file_path: "new-file.ts" }, "Writing new-file.ts"],
    ["write", { filePath: "src/new-file.ts" }, "Writing src/new-file.ts"],
    ["write_file", { filepath: "src/new-file.ts" }, "Writing src/new-file.ts"],
    ["Bash", { command: "npm test" }, "Running npm test"],
    ["execute_command", { cmd: "npm run typecheck" }, "Running npm run typecheck"],
    ["Grep", { pattern: "TODO" }, "Searching for TODO"],
    ["glob", { pattern: "**/*.ts" }, "Finding **/*.ts"],
    ["search_files", { query: "FIXME" }, "Searching for FIXME"],
  ])("formats %s tool calls", (tool, args, expected) => {
    expect(formatToolStatus(tool, args)).toBe(expected);
  });

  it("uses safe argument fallbacks", () => {
    expect(formatToolStatus("Read", {})).toBe("Reading file");
    expect(formatToolStatus("Bash", {})).toBe("Running command");
    expect(formatToolStatus("Grep", {})).toBe("Searching for query");
    expect(formatToolStatus("Glob", {})).toBe("Finding files");
  });

  it("formats unknown tools safely", () => {
    expect(formatToolStatus("Custom Tool\n<@U123>", {})).toBe("Using tool: Custom Tool @U123");
  });

  it("truncates long display arguments", () => {
    const path = `src/${"a".repeat(100)}.ts`;

    expect(formatToolStatus("Read", { file_path: path })).toBe(`Reading ${"a".repeat(39)}...`);
  });
});

describe("normalizeStatusText", () => {
  it("collapses status text to one mention-safe line", () => {
    expect(
      normalizeStatusText("run\n <!channel> <!here> <!subteam^S123|eng> <@U123> <#C123|general>")
    ).toBe("run channel here eng @U123 #general");
  });
});

describe("truncateStatusPart", () => {
  it("keeps short values and caps long values at 80 characters", () => {
    expect(truncateStatusPart("short")).toBe("short");

    const truncated = truncateStatusPart("a".repeat(100));
    expect(truncated).toHaveLength(80);
    expect(truncated.endsWith("...")).toBe(true);
  });
});

describe("setAssistantThreadStatus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the expected assistant thread status request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await setAssistantThreadStatus(
      "xoxb-test",
      "C123",
      "111.222",
      "Running npm test"
    );

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("https://slack.com/api/assistant.threads.setStatus", {
      method: "POST",
      headers: {
        Authorization: "Bearer xoxb-test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel_id: "C123",
        thread_ts: "111.222",
        status: "Running npm test",
      }),
    });
  });

  it("sends loading messages when provided", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      setAssistantThreadStatus("xoxb-test", "C123", "111.222", "Working...", {
        loadingMessages: ["Reading\n<@U123>"],
      })
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith("https://slack.com/api/assistant.threads.setStatus", {
      method: "POST",
      headers: {
        Authorization: "Bearer xoxb-test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel_id: "C123",
        thread_ts: "111.222",
        status: "Working...",
        loading_messages: ["Reading @U123"],
      }),
    });
  });

  it("truncates loading messages as complete status strings", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      setAssistantThreadStatus("xoxb-test", "C123", "111.222", "Working...", {
        loadingMessages: [`Searching for ${"a".repeat(100)}`],
      })
    ).resolves.toEqual({ ok: true });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as {
      loading_messages: string[];
    };
    expect(body.loading_messages[0]).toHaveLength(50);
    expect(body.loading_messages[0]).toBe(`Searching for ${"a".repeat(33)}...`);
  });

  it("maps Slack rate limits to a failure envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 429, headers: { "Retry-After": "7" } })
    );

    await expect(
      setAssistantThreadStatus("xoxb-test", "C123", "111.222", "Reading auth.ts")
    ).resolves.toEqual({ ok: false, error: "ratelimited", retryAfter: 7 });
  });

  it("returns Slack error envelopes without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      setAssistantThreadStatus("xoxb-test", "C123", "111.222", "Reading auth.ts")
    ).resolves.toEqual({ ok: false, error: "missing_scope" });
  });

  it("returns Slack error diagnostics for invalid arguments", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: "invalid_arguments",
          detail: "loading_messages[0] is invalid",
          response_metadata: { messages: ["loading_messages[0] is invalid"] },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    await expect(
      setAssistantThreadStatus("xoxb-test", "C123", "111.222", "Working...", {
        loadingMessages: ["Searching for TODO"],
      })
    ).resolves.toEqual({
      ok: false,
      error: "invalid_arguments",
      detail: "loading_messages[0] is invalid",
      responseMetadata: { messages: ["loading_messages[0] is invalid"] },
    });
  });

  it("rejects Slack error envelopes without a string error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 123 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      setAssistantThreadStatus("xoxb-test", "C123", "111.222", "Reading auth.ts")
    ).resolves.toEqual({ ok: false, error: "invalid_response" });
  });

  it.each([
    [new Response("oops", { status: 500 }), { ok: false, error: "http_500" }],
    [new Response("{", { status: 200 }), { ok: false, error: "invalid_response" }],
  ])("maps failed HTTP or malformed responses", async (response, expected) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(
      setAssistantThreadStatus("xoxb-test", "C123", "111.222", "Reading auth.ts")
    ).resolves.toEqual(expected);
  });

  it("maps network errors to a failure envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(
      setAssistantThreadStatus("xoxb-test", "C123", "111.222", "Reading auth.ts")
    ).resolves.toEqual({ ok: false, error: "network_error" });
  });
});
