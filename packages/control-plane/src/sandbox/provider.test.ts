import { describe, expect, it } from "vitest";
import { createVncAccess } from "./provider";

describe("createVncAccess", () => {
  it("returns only complete VNC credentials", () => {
    expect(createVncAccess("https://vnc.test", "secret")).toEqual({
      url: "https://vnc.test",
      password: "secret",
    });
    expect(createVncAccess("https://vnc.test", undefined)).toBeUndefined();
    expect(createVncAccess(undefined, "secret")).toBeUndefined();
  });
});
