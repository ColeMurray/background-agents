import { describe, expect, it } from "vitest";
import { resolveComputerWorkspaceMode } from "./computer-workspace-mode";

describe("resolveComputerWorkspaceMode", () => {
  it.each([undefined, "", "off", "OFF", "unknown"])("fails closed for %s", (value) => {
    expect(resolveComputerWorkspaceMode(value)).toBe("off");
  });

  it.each(["read_only", " READ_ONLY "])("enables the read-only workspace for %s", (value) => {
    expect(resolveComputerWorkspaceMode(value)).toBe("read_only");
  });

  it("delegates enabled mode to the canonical capability resolver", () => {
    expect(resolveComputerWorkspaceMode("enabled")).toBe("enabled");
  });

  it("keeps the future writable value disabled", () => {
    expect(resolveComputerWorkspaceMode("writable")).toBe("off");
  });
});
