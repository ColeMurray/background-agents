import { describe, expect, it } from "vitest";
import {
  formatToolAction,
  isValidPayload,
  isValidToolCallPayload,
  verifyCallbackSignature,
} from "./callbacks";

// ─── formatToolAction ────────────────────────────────────────────────────────

describe("formatToolAction", () => {
  it("edit_file with filepath", () => {
    expect(formatToolAction("edit_file", { filepath: "src/main.ts" })).toBe(
      "Editing `src/main.ts`"
    );
  });

  it("write_file with path", () => {
    expect(formatToolAction("write_file", { path: "out/bundle.js" })).toBe(
      "Editing `out/bundle.js`"
    );
  });

  it("edit_file falls back to 'file' when no filepath or path", () => {
    expect(formatToolAction("edit_file", {})).toBe("Editing `file`");
  });

  it("read_file with filepath", () => {
    expect(formatToolAction("read_file", { filepath: "README.md" })).toBe("Reading `README.md`");
  });

  it("read_file with path", () => {
    expect(formatToolAction("read_file", { path: "docs/guide.md" })).toBe(
      "Reading `docs/guide.md`"
    );
  });

  it("read_file falls back to 'file' when no filepath or path", () => {
    expect(formatToolAction("read_file", {})).toBe("Reading `file`");
  });

  it("bash with command", () => {
    expect(formatToolAction("bash", { command: "npm test" })).toBe("Running `npm test`");
  });

  it("execute_command with cmd", () => {
    expect(formatToolAction("execute_command", { cmd: "ls -la" })).toBe("Running `ls -la`");
  });

  it("bash with command >80 chars truncates to 77 + ...", () => {
    const longCmd = "a".repeat(100);
    const result = formatToolAction("bash", { command: longCmd });
    expect(result).toBe(`Running \`${"a".repeat(77)}...\``);
  });

  it("bash with command exactly 80 chars is not truncated", () => {
    const cmd = "a".repeat(80);
    expect(formatToolAction("bash", { command: cmd })).toBe(`Running \`${cmd}\``);
  });

  it("bash with no command renders empty", () => {
    expect(formatToolAction("bash", {})).toBe("Running ``");
  });

  it("unknown tool → 'Using tool: {name}'", () => {
    expect(formatToolAction("search_files", { query: "foo" })).toBe("Using tool: search_files");
  });
});

// ─── isValidToolCallPayload ──────────────────────────────────────────────────

describe("isValidToolCallPayload", () => {
  const valid = {
    sessionId: "sess-1",
    tool: "bash",
    args: { command: "ls" },
    callId: "call-1",
    timestamp: Date.now(),
    signature: "abc123",
    context: {
      source: "linear" as const,
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueUrl: "https://linear.app/issue/ENG-1",
      repoFullName: "org/repo",
      model: "claude-sonnet-4-5",
    },
  };

  it("accepts a complete valid payload", () => {
    expect(isValidToolCallPayload(valid)).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidToolCallPayload(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isValidToolCallPayload(undefined)).toBe(false);
  });

  it("rejects missing sessionId", () => {
    const { sessionId: _, ...rest } = valid;
    expect(isValidToolCallPayload(rest)).toBe(false);
  });

  it("rejects missing tool", () => {
    const { tool: _, ...rest } = valid;
    expect(isValidToolCallPayload(rest)).toBe(false);
  });

  it("rejects missing timestamp", () => {
    const { timestamp: _, ...rest } = valid;
    expect(isValidToolCallPayload(rest)).toBe(false);
  });

  it("rejects missing signature", () => {
    const { signature: _, ...rest } = valid;
    expect(isValidToolCallPayload(rest)).toBe(false);
  });

  it("rejects context: null", () => {
    expect(isValidToolCallPayload({ ...valid, context: null })).toBe(false);
  });

  it("rejects sessionId of wrong type", () => {
    expect(isValidToolCallPayload({ ...valid, sessionId: 123 })).toBe(false);
  });
});

// ─── verifyCallbackSignature ─────────────────────────────────────────────────

describe("verifyCallbackSignature", () => {
  const TEST_SECRET = "test-hmac-secret-for-unit-tests";

  async function signPayload(data: Record<string, unknown>, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(data)));
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  it("returns true for a valid signature", async () => {
    const data = { sessionId: "sess-1", message: "test" };
    const signature = await signPayload(data, TEST_SECRET);

    const result = await verifyCallbackSignature({ ...data, signature }, TEST_SECRET);
    expect(result).toBe(true);
  });

  it("returns false for a tampered signature", async () => {
    const data = { sessionId: "sess-1", message: "test" };
    const result = await verifyCallbackSignature({ ...data, signature: "deadbeef" }, TEST_SECRET);
    expect(result).toBe(false);
  });

  it("returns false when signed with wrong secret", async () => {
    const data = { sessionId: "sess-1", message: "test" };
    const signature = await signPayload(data, "wrong-secret");

    const result = await verifyCallbackSignature({ ...data, signature }, TEST_SECRET);
    expect(result).toBe(false);
  });
});

// ─── isValidPayload (completion callback) ────────────────────────────────────

describe("isValidPayload", () => {
  const validCompletion = {
    sessionId: "sess-1",
    messageId: "msg-1",
    success: true,
    timestamp: Date.now(),
    signature: "abc123",
    context: {
      source: "linear" as const,
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueUrl: "https://linear.app/issue/ENG-1",
      repoFullName: "org/repo",
    },
  };

  it("accepts a valid completion payload", () => {
    expect(isValidPayload(validCompletion)).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidPayload(null)).toBe(false);
  });

  it("rejects missing sessionId", () => {
    const { sessionId: _, ...rest } = validCompletion;
    expect(isValidPayload(rest)).toBe(false);
  });

  it("rejects missing messageId", () => {
    const { messageId: _, ...rest } = validCompletion;
    expect(isValidPayload(rest)).toBe(false);
  });

  it("rejects missing success field", () => {
    const { success: _, ...rest } = validCompletion;
    expect(isValidPayload(rest)).toBe(false);
  });

  it("rejects context without issueId", () => {
    const { issueId: _, ...badContext } = validCompletion.context;
    expect(isValidPayload({ ...validCompletion, context: badContext })).toBe(false);
  });
});
