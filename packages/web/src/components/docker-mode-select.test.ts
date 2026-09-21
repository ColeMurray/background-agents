import { describe, expect, it } from "vitest";
import { dockerEnabledForMode } from "./docker-mode-select";

describe("dockerEnabledForMode", () => {
  it("forwards only an explicit override", () => {
    expect(dockerEnabledForMode("default")).toBeUndefined();
    expect(dockerEnabledForMode("standard")).toBe(false);
    expect(dockerEnabledForMode("docker")).toBe(true);
  });
});
