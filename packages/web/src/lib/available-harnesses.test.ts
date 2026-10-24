import { describe, expect, it } from "vitest";
import { availableHarnessIds } from "./available-harnesses";

describe("availableHarnessIds", () => {
  it("keeps Pi Durable hidden by default", () => {
    expect(availableHarnessIds(undefined)).toEqual(["opencode", "claude", "codex"]);
  });

  it.each(["true", "1", " TRUE "])("advertises Pi Durable when enabled with %s", (value) => {
    expect(availableHarnessIds(value)).toEqual(["opencode", "claude", "codex", "pi"]);
  });
});
