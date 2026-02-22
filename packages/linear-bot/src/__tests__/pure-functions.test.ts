import { describe, expect, it } from "vitest";
import {
  extractModelFromLabels,
  resolveSessionModelSettings,
  resolveStaticRepo,
} from "../model-resolution";
import { isValidPayload, verifyCallbackSignature } from "../callbacks";
import type { CompletionCallback } from "../types";

// ─── extractModelFromLabels ──────────────────────────────────────────────────

describe("extractModelFromLabels", () => {
  it("returns model for a valid label", () => {
    expect(extractModelFromLabels([{ name: "model:opus" }])).toBe("anthropic/claude-opus-4-5");
  });

  it("returns model for case-insensitive label", () => {
    expect(extractModelFromLabels([{ name: "Model:Sonnet" }])).toBe("anthropic/claude-sonnet-4-5");
  });

  it("returns null for unknown model label", () => {
    expect(extractModelFromLabels([{ name: "model:unknown-model" }])).toBeNull();
  });

  it("returns null when no model labels present", () => {
    expect(extractModelFromLabels([{ name: "bug" }, { name: "urgent" }])).toBeNull();
  });

  it("returns null for empty labels", () => {
    expect(extractModelFromLabels([])).toBeNull();
  });
});

// ─── resolveStaticRepo ──────────────────────────────────────────────────────

describe("resolveStaticRepo", () => {
  const mapping = {
    "team-1": [
      { owner: "org", name: "frontend", label: "frontend" },
      { owner: "org", name: "backend", label: "backend" },
      { owner: "org", name: "default-repo" },
    ],
  };

  it("matches by label", () => {
    const result = resolveStaticRepo(mapping, "team-1", ["Frontend"]);
    expect(result).toEqual({ owner: "org", name: "frontend", label: "frontend" });
  });

  it("falls back to entry without label", () => {
    const result = resolveStaticRepo(mapping, "team-1", ["unrelated"]);
    expect(result).toEqual({ owner: "org", name: "default-repo" });
  });

  it("returns null for empty mapping", () => {
    expect(resolveStaticRepo({}, "team-1")).toBeNull();
  });

  it("returns null for unknown team", () => {
    expect(resolveStaticRepo(mapping, "team-unknown")).toBeNull();
  });
});

describe("resolveSessionModelSettings", () => {
  it("uses integration model when overrides are disabled", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: "anthropic/claude-haiku-4-5",
      configModel: "anthropic/claude-sonnet-4-6",
      configReasoningEffort: "high",
      allowUserPreferenceOverride: false,
      allowLabelModelOverride: false,
      userModel: "openai/gpt-5.3-codex",
      labelModel: "anthropic/claude-opus-4-6",
    });

    expect(result.model).toBe("anthropic/claude-sonnet-4-6");
    expect(result.reasoningEffort).toBe("high");
  });

  it("applies user preference when enabled", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: "anthropic/claude-haiku-4-5",
      configModel: "anthropic/claude-sonnet-4-6",
      configReasoningEffort: null,
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: false,
      userModel: "openai/gpt-5.3-codex",
      userReasoningEffort: "xhigh",
    });

    expect(result.model).toBe("openai/gpt-5.3-codex");
    expect(result.reasoningEffort).toBe("xhigh");
  });

  it("does not let config effort override user effort when user model wins", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: "anthropic/claude-haiku-4-5",
      configModel: "anthropic/claude-sonnet-4-6",
      configReasoningEffort: "low",
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: false,
      userModel: "openai/gpt-5.3-codex",
      userReasoningEffort: "xhigh",
    });

    expect(result.model).toBe("openai/gpt-5.3-codex");
    expect(result.reasoningEffort).toBe("xhigh");
  });

  it("applies label override over user preference when enabled", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: "anthropic/claude-haiku-4-5",
      configModel: null,
      configReasoningEffort: null,
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: true,
      userModel: "openai/gpt-5.3-codex",
      labelModel: "anthropic/claude-opus-4-6",
      userReasoningEffort: "xhigh",
    });

    expect(result.model).toBe("anthropic/claude-opus-4-6");
    expect(result.reasoningEffort).toBe("high");
  });

  it("falls back to model default reasoning effort when invalid", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: "anthropic/claude-haiku-4-5",
      configModel: "anthropic/claude-opus-4-6",
      configReasoningEffort: "xhigh",
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: false,
      userReasoningEffort: "xhigh",
    });

    expect(result.model).toBe("anthropic/claude-opus-4-6");
    expect(result.reasoningEffort).toBe("high");
  });

  it("uses config reasoning effort when config model is selected", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: "anthropic/claude-haiku-4-5",
      configModel: "anthropic/claude-opus-4-6",
      configReasoningEffort: "max",
      allowUserPreferenceOverride: false,
      allowLabelModelOverride: false,
      userReasoningEffort: "low",
    });

    expect(result.model).toBe("anthropic/claude-opus-4-6");
    expect(result.reasoningEffort).toBe("max");
  });
});

// ─── isValidPayload ─────────────────────────────────────────────────────────

describe("isValidPayload", () => {
  const validPayload: CompletionCallback = {
    sessionId: "sess-1",
    messageId: "msg-1",
    success: true,
    timestamp: Date.now(),
    signature: "abc123",
    context: {
      source: "linear",
      issueId: "issue-1",
      issueIdentifier: "ENG-123",
      issueUrl: "https://linear.app/issue/ENG-123",
      repoFullName: "org/repo",
      model: "claude-sonnet-4-5",
    },
  };

  it("accepts a complete payload", () => {
    expect(isValidPayload(validPayload)).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidPayload(null)).toBe(false);
  });

  it("rejects missing sessionId", () => {
    const { sessionId: _sessionId, ...rest } = validPayload;
    expect(isValidPayload(rest)).toBe(false);
  });

  it("rejects missing context.issueId", () => {
    const bad = { ...validPayload, context: { ...validPayload.context, issueId: undefined } };
    expect(isValidPayload(bad)).toBe(false);
  });

  it("rejects missing signature", () => {
    const { signature: _signature, ...rest } = validPayload;
    expect(isValidPayload(rest)).toBe(false);
  });
});

// ─── verifyCallbackSignature ────────────────────────────────────────────────

describe("verifyCallbackSignature", () => {
  const secret = "test-secret-key";

  async function signPayload(data: Record<string, unknown>): Promise<string> {
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

  it("returns true for valid signature", async () => {
    const data = {
      sessionId: "sess-1",
      messageId: "msg-1",
      success: true,
      timestamp: 1234567890,
      context: {
        source: "linear" as const,
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        issueUrl: "https://linear.app/issue/ENG-1",
        repoFullName: "org/repo",
        model: "claude-sonnet-4-5",
      },
    };
    const signature = await signPayload(data);
    const payload = { ...data, signature } as CompletionCallback;
    expect(await verifyCallbackSignature(payload, secret)).toBe(true);
  });

  it("returns false for invalid signature", async () => {
    const payload: CompletionCallback = {
      sessionId: "sess-1",
      messageId: "msg-1",
      success: true,
      timestamp: 1234567890,
      signature: "invalid-hex-signature",
      context: {
        source: "linear",
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        issueUrl: "https://linear.app/issue/ENG-1",
        repoFullName: "org/repo",
        model: "claude-sonnet-4-5",
      },
    };
    expect(await verifyCallbackSignature(payload, secret)).toBe(false);
  });
});
