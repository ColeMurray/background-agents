import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import type { SqlDatabase } from "./db/sql-database";
import {
  resolveHarnessSelection,
  resolveChildHarnessSelection,
  resolveHarnessAutomationUpdate,
  resolveHarnessInitialization,
  validateHarnessExecution,
} from "./harness-admission";

const { getEnabledModels } = vi.hoisted(() => ({ getEnabledModels: vi.fn() }));
vi.mock("./db/model-preferences", () => ({
  ModelPreferencesStore: class {
    getEnabledModels = getEnabledModels;
  },
}));
const db = {} as SqlDatabase;

describe("consolidated selection boundaries", () => {
  it.each(["opencode", "claude"] as const)(
    "does not add deployment revalidation to historical %s executions",
    async (harness) => {
      getEnabledModels.mockRejectedValue(new Error("storage unavailable"));
      await expect(
        validateHarnessExecution(db, { harness, model: DEFAULT_MODEL, reasoningEffort: "invalid" })
      ).resolves.toBeUndefined();
      expect(getEnabledModels).not.toHaveBeenCalled();
      expect(resolveHarnessInitialization(harness, { model: "unknown" })).toEqual({
        model: DEFAULT_MODEL,
        reasoningEffort: undefined,
      });
    }
  );
  it("checks current native model availability and resolved auth again at dispatch", async () => {
    await expect(
      validateHarnessExecution(
        db,
        { harness: "codex", model: "openai/gpt-6.1-sol" },
        { openai: "legacy_scoped_oauth" }
      )
    ).rejects.toThrow("legacy_scoped_oauth");
    getEnabledModels.mockResolvedValue([DEFAULT_MODEL]);
    await expect(
      validateHarnessExecution(db, { harness: "codex", model: "openai/gpt-6.1-sol" })
    ).rejects.toThrow("not enabled");
  });
  it("does not silently repair invalid internal native initialization", () => {
    expect(() => resolveHarnessInitialization("codex", {})).toThrow("cannot run");
    expect(() => resolveHarnessInitialization("codex", { model: "unknown" })).toThrow("cannot run");
    expect(resolveHarnessInitialization("codex", { model: "gpt-6.1-sol" })).toEqual({
      model: "openai/gpt-6.1-sol",
      reasoningEffort: "low",
    });
  });
  it("allows native metadata-only edits even when the enabled catalog is unavailable", async () => {
    getEnabledModels.mockRejectedValue(new Error("storage unavailable"));
    await expect(
      resolveHarnessAutomationUpdate(
        db,
        { model: "openai/gpt-5.6-sol", reasoningEffort: "max" },
        { harness: "codex", executionChanged: false }
      )
    ).resolves.toEqual({ model: "openai/gpt-5.6-sol", reasoningEffort: "max" });
    expect(getEnabledModels).not.toHaveBeenCalled();
    await expect(
      resolveHarnessAutomationUpdate(
        db,
        { model: "openai/gpt-5.6-sol", reasoningEffort: "max" },
        { harness: "codex", executionChanged: true }
      )
    ).rejects.toThrow("storage unavailable");
  });
  it("preserves legacy effort clearing when an automation changes models", async () => {
    await expect(
      resolveHarnessAutomationUpdate(
        db,
        { model: DEFAULT_MODEL, reasoningEffort: "max" },
        { harness: "opencode", model: "openai/gpt-5.4", executionChanged: true }
      )
    ).resolves.toEqual({ model: "openai/gpt-5.4", reasoningEffort: null });
  });
  it("reuses the loaded catalog for native child model and effort inheritance", async () => {
    getEnabledModels.mockRejectedValue(new Error("must not reread the catalog"));
    await expect(
      resolveChildHarnessSelection(
        db,
        { harness: "codex", model: "openai/gpt-5.6-sol", reasoningEffort: "max" },
        {},
        ["openai/gpt-5.6-sol"]
      )
    ).resolves.toEqual({ model: "openai/gpt-5.6-sol", reasoningEffort: "max" });
    expect(getEnabledModels).not.toHaveBeenCalled();
  });
  it("uses a qualified enabled child default and drops incompatible inherited effort", async () => {
    getEnabledModels.mockResolvedValue([DEFAULT_MODEL, "openai/gpt-5.5"]);
    await expect(
      resolveChildHarnessSelection(
        db,
        { harness: "codex", model: "openai/gpt-5.6-sol", reasoningEffort: "max" },
        {},
        [DEFAULT_MODEL, "openai/gpt-5.5"]
      )
    ).resolves.toEqual({ model: "openai/gpt-5.5", reasoningEffort: "medium" });
  });
  it("rejects explicitly incompatible child effort rather than discarding it", async () => {
    await expect(
      resolveChildHarnessSelection(
        db,
        { harness: "opencode", model: DEFAULT_MODEL, reasoningEffort: null },
        { reasoningEffort: "invalid" },
        [DEFAULT_MODEL]
      )
    ).rejects.toThrow("Invalid reasoning effort");
    await expect(
      resolveChildHarnessSelection(
        db,
        { harness: "codex", model: "openai/gpt-6.1-sol", reasoningEffort: null },
        { reasoningEffort: "invalid" },
        ["openai/gpt-6.1-sol"]
      )
    ).rejects.toThrow("Invalid reasoning effort");
  });
});
beforeEach(() => {
  getEnabledModels.mockReset();
  getEnabledModels.mockResolvedValue([
    DEFAULT_MODEL,
    "openai/gpt-5.4",
    "openai/gpt-6.1-sol",
    "openai/gpt-5.6-sol",
  ]);
});

describe("Codex admission", () => {
  it("uses an enabled native default instead of the Anthropic deployment default", async () => {
    await expect(resolveHarnessSelection(db, { harness: "codex" })).resolves.toEqual({
      model: "openai/gpt-6.1-sol",
      reasoningEffort: "low",
    });
  });
  it("accepts native max even when legacy global model config does not", async () => {
    await expect(
      resolveHarnessSelection(db, {
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
      })
    ).resolves.toEqual({ model: "openai/gpt-5.6-sol", reasoningEffort: "max" });
  });
  it.each(["bogus", "anthropic/claude-sonnet-4-6", "openai/gpt-5.4"])(
    "never substitutes explicit incompatible model %s",
    async (model) => {
      await expect(resolveHarnessSelection(db, { harness: "codex", model })).rejects.toThrow(
        "cannot run"
      );
    }
  );
  it("rejects disabled native models and unavailable preference storage", async () => {
    await expect(
      resolveHarnessSelection(db, { harness: "codex", model: "openai/gpt-5.5" })
    ).rejects.toThrow("not enabled");
    getEnabledModels.mockRejectedValue(new Error("storage unavailable"));
    await expect(resolveHarnessSelection(db, { harness: "codex" })).rejects.toThrow(
      "storage unavailable"
    );
  });
  it("preserves omitted OpenCode defaults without reading deployment model policy", async () => {
    await expect(resolveHarnessSelection(db, { harness: "opencode" })).resolves.toEqual({
      model: DEFAULT_MODEL,
      reasoningEffort: null,
    });
    expect(getEnabledModels).not.toHaveBeenCalled();
  });
});
