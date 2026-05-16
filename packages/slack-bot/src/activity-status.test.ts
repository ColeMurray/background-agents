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
    ["read_file", { filepath: "lib/auth.ts" }, "Reading lib/auth.ts"],
    ["Edit", { file: "src/handler.ts" }, "Editing src/handler.ts"],
    ["edit_file", { path: "handler.ts" }, "Editing handler.ts"],
    ["Write", { file_path: "new-file.ts" }, "Writing new-file.ts"],
    ["write_file", { filepath: "src/new-file.ts" }, "Writing src/new-file.ts"],
    ["Bash", { command: "npm test" }, "Running npm test"],
    ["execute_command", { cmd: "npm run typecheck" }, "Running npm run typecheck"],
    ["Grep", { pattern: "TODO" }, "Searching for TODO"],
    ["search_files", { query: "FIXME" }, "Searching for FIXME"],
  ])("formats %s tool calls", (tool, args, expected) => {
    expect(formatToolStatus(tool, args)).toBe(expected);
  });

  it("uses safe argument fallbacks", () => {
    expect(formatToolStatus("Read", {})).toBe("Reading file");
    expect(formatToolStatus("Bash", {})).toBe("Running command");
    expect(formatToolStatus("Grep", {})).toBe("Searching for query");
  });

  it("formats unknown tools safely", () => {
    expect(formatToolStatus("Custom Tool\n<@U123>", {})).toBe("Using tool: Custom Tool @U123");
  });

  it("truncates long display arguments", () => {
    const path = `src/${"a".repeat(100)}.ts`;

    expect(formatToolStatus("Read", { file_path: path })).toBe(
      `Reading ${"src/" + "a".repeat(73)}...`
    );
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
