import { describe, expect, it } from "vitest";
import { resolveSessionCapabilities } from "./session-capabilities";

describe("resolveSessionCapabilities", () => {
  it("grants trace export only to users with sessions.export", () => {
    const readOnly = resolveSessionCapabilities((permission) => permission === "sessions.read");
    expect(readOnly.exportTrace).toBe(false);
    const exporter = resolveSessionCapabilities((permission) => permission === "sessions.export");
    expect(exporter.exportTrace).toBe(true);
  });
});
