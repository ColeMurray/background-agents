import { describe, expect, it } from "vitest";
import { getLaunchConfig, LaunchConfigError } from "./launch-config";
import { createEnv } from "./test-helpers";

describe("Discord v1 launch configuration", () => {
  it("preserves the deployed Claude default and accepts OpenCode", () => {
    expect(getLaunchConfig(createEnv())).toEqual({
      harness: "claude",
      model: "anthropic/claude-opus-5",
    });
    expect(getLaunchConfig(createEnv({ HARNESS: "opencode" })).harness).toBe("opencode");
  });

  it.each(["", "cursor", "codex", " claude "])(
    "rejects an unsupported harness %j without falling back",
    (harness) => {
      expect(() => getLaunchConfig(createEnv({ HARNESS: harness }))).toThrow(
        "Set HARNESS to claude or opencode"
      );
    }
  );

  it.each(["", "unknown/model"])("rejects an unknown model %j without falling back", (model) => {
    expect(() => getLaunchConfig(createEnv({ DEFAULT_MODEL: model }))).toThrow(
      "Set DEFAULT_MODEL to a supported model ID"
    );
  });

  it("uses shared compatibility rules to reject a non-Anthropic model for Claude", () => {
    expect(() => getLaunchConfig(createEnv({ DEFAULT_MODEL: "openai/gpt-6-sol" }))).toThrow(
      "compatible with Claude Agent"
    );
  });

  it("caches both valid and invalid results per bindings object", () => {
    const valid = createEnv();
    const config = getLaunchConfig(valid);
    valid.HARNESS = "cursor";
    expect(getLaunchConfig(valid)).toBe(config);
    const invalid = createEnv({ HARNESS: "cursor" });
    expect(() => getLaunchConfig(invalid)).toThrow(LaunchConfigError);
    invalid.HARNESS = "claude";
    expect(() => getLaunchConfig(invalid)).toThrow(LaunchConfigError);
    expect(getLaunchConfig(createEnv()).harness).toBe("claude");
  });
});
