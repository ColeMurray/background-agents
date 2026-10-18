import { describe, expect, it } from "vitest";
import { resolveComputerWorkspaceMode } from "./computer-workspace-mode";

describe("resolveComputerWorkspaceMode", () => {
  it.each([undefined, "", "off", "OFF", "unknown"])("fails closed for %s", (value) => {
    expect(resolveComputerWorkspaceMode(value)).toBe("off");
  });

  it.each(["read_only", " READ_ONLY "])("enables the read-only workspace for %s", (value) => {
    expect(resolveComputerWorkspaceMode(value)).toBe("read_only");
  });

  it.each(["enabled", "writable", " WRITABLE "])(
    "enables the writable workspace for %s",
    (value) => expect(resolveComputerWorkspaceMode(value)).toBe("enabled")
  );
});
