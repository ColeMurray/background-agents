import { describe, expect, it } from "vitest";
import {
  extractModelFromLabels,
  resolveSessionModelSettings,
  resolveStaticTarget,
} from "../model-resolution";
import { isValidPayload } from "../callbacks";
import { buildOAuthSuccessHtml } from "../index";
import type { CompletionCallback } from "../types";

describe("buildOAuthSuccessHtml", () => {
  it("renders the configured app name in the heading", () => {
    const html = buildOAuthSuccessHtml("Acme Bot", "My Workspace");
    expect(html).toContain("<h1>Acme Bot Agent Installed!</h1>");
    expect(html).toContain("<strong>My Workspace</strong>");
  });

  it("escapes the app name to prevent HTML injection", () => {
    const html = buildOAuthSuccessHtml("<script>alert(1)</script>", "Acme");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes the workspace name to prevent HTML injection", () => {
    const html = buildOAuthSuccessHtml("Open-Inspect", "Evil <img src=x>");
    expect(html).toContain("Evil &lt;img src=x&gt;");
  });
});

// ─── extractModelFromLabels ──────────────────────────────────────────────────

describe("extractModelFromLabels", () => {
  it("returns model for a valid label", () => {
    expect(extractModelFromLabels([{ name: "model:opus" }])).toBe("anthropic/claude-opus-4-5");
  });

  it("returns model for case-insensitive label", () => {
    expect(extractModelFromLabels([{ name: "Model:Sonnet" }])).toBe("anthropic/claude-sonnet-4-5");
  });

  it("returns GPT 5.4 for model:gpt-5.4 label", () => {
    expect(extractModelFromLabels([{ name: "model:gpt-5.4" }])).toBe("openai/gpt-5.4");
  });

  it("returns GPT 5.5 for model:gpt-5.5 label", () => {
    expect(extractModelFromLabels([{ name: "model:gpt-5.5" }])).toBe("openai/gpt-5.5");
  });

  it.each(["gpt-5.2", "gpt-5.2-codex"])("returns null for unsupported model:%s label", (model) => {
    expect(extractModelFromLabels([{ name: `model:${model}` }])).toBeNull();
  });

  it.each([
    ["sol", "openai/gpt-5.6-sol"],
    ["terra", "openai/gpt-5.6-terra"],
    ["luna", "openai/gpt-5.6-luna"],
  ])("returns GPT 5.6 %s for its model label", (variant, expected) => {
    expect(extractModelFromLabels([{ name: `model:gpt-5.6-${variant}` }])).toBe(expected);
  });

  it("returns Opus 4.7 for model:opus-4-7 label", () => {
    expect(extractModelFromLabels([{ name: "model:opus-4-7" }])).toBe("anthropic/claude-opus-4-7");
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

// ─── resolveStaticTarget ────────────────────────────────────────────────────

describe("resolveStaticTarget", () => {
  const mapping = {
    "team-1": [
      { owner: "org", name: "frontend", label: "frontend" },
      { owner: "org", name: "backend", label: "backend" },
      { owner: "org", name: "default-repo" },
    ],
  };

  it("matches by label", () => {
    const result = resolveStaticTarget(mapping, "team-1", ["Frontend"]);
    expect(result).toEqual({ owner: "org", name: "frontend", label: "frontend" });
  });

  it("falls back to entry without label", () => {
    const result = resolveStaticTarget(mapping, "team-1", ["unrelated"]);
    expect(result).toEqual({ owner: "org", name: "default-repo" });
  });

  it("returns null for empty mapping", () => {
    expect(resolveStaticTarget({}, "team-1")).toBeNull();
  });

  it("returns null for unknown team", () => {
    expect(resolveStaticTarget(mapping, "team-unknown")).toBeNull();
  });

  it("matches an environment entry by label", () => {
    const mixed = {
      "team-1": [
        { environmentId: "env_fullstack", label: "fullstack" },
        { owner: "org", name: "default-repo" },
      ],
    };
    expect(resolveStaticTarget(mixed, "team-1", ["Fullstack"])).toEqual({
      environmentId: "env_fullstack",
      label: "fullstack",
    });
  });

  it("falls back to a label-less environment entry", () => {
    const mixed = {
      "team-1": [
        { owner: "org", name: "frontend", label: "frontend" },
        { environmentId: "env_fullstack" },
      ],
    };
    expect(resolveStaticTarget(mixed, "team-1", [])).toEqual({ environmentId: "env_fullstack" });
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
