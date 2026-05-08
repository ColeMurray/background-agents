import { describe, expect, it } from "vitest";
import { DEFAULT_APP_NAME, resolveAppName } from "./app-name";

describe("resolveAppName", () => {
  it("returns the default when env is undefined", () => {
    expect(resolveAppName(undefined)).toBe(DEFAULT_APP_NAME);
  });

  it("returns the default when env is null", () => {
    expect(resolveAppName(null)).toBe(DEFAULT_APP_NAME);
  });

  it("returns the default when APP_NAME is missing", () => {
    expect(resolveAppName({})).toBe(DEFAULT_APP_NAME);
  });

  it("returns the default when APP_NAME is empty", () => {
    expect(resolveAppName({ APP_NAME: "" })).toBe(DEFAULT_APP_NAME);
  });

  it("returns the default when APP_NAME is only whitespace", () => {
    expect(resolveAppName({ APP_NAME: "   " })).toBe(DEFAULT_APP_NAME);
  });

  it("returns a configured value", () => {
    expect(resolveAppName({ APP_NAME: "Acme Bot" })).toBe("Acme Bot");
  });

  it("trims surrounding whitespace from a configured value", () => {
    expect(resolveAppName({ APP_NAME: "  Acme Bot  " })).toBe("Acme Bot");
  });

  it("DEFAULT_APP_NAME is Open-Inspect", () => {
    expect(DEFAULT_APP_NAME).toBe("Open-Inspect");
  });
});
