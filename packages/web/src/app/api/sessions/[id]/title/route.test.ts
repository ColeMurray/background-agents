import { describe, expect, it } from "vitest";

import { parseSessionTitlePatchBody } from "./route";

describe("session title API route", () => {
  describe("parseSessionTitlePatchBody", () => {
    it("parses a valid title request", () => {
      expect(parseSessionTitlePatchBody({ title: "Investigate failing build" })).toEqual({
        title: "Investigate failing build",
      });
    });

    it("parses an omitted title", () => {
      expect(parseSessionTitlePatchBody({})).toEqual({ title: undefined });
    });

    it("rejects a malformed title request", () => {
      expect(parseSessionTitlePatchBody({ title: 123 })).toBeNull();
      expect(parseSessionTitlePatchBody(null)).toBeNull();
    });
  });
});
