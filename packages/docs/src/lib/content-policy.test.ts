import { describe, expect, it } from "vitest";

import { parsePublicPage } from "./content-policy";

const validPage = {
  title: "Quickstart",
  description: "Start a session.",
  audience: "user",
  owner: "web",
  status: "published",
  lastReviewed: "2026-09-04",
  relatedCode: ["packages/web/src/components/session-target-picker.tsx"],
};

describe("public documentation content policy", () => {
  it("accepts a complete public page", () => {
    expect(parsePublicPage(validPage)).toMatchObject({ lastReviewed: "2026-09-04" });
  });

  it("rejects internal content from the public collection", () => {
    expect(() => parsePublicPage({ ...validPage, audience: "internal" })).toThrow(/audience/i);
  });

  it("rejects unpublished content", () => {
    expect(() => parsePublicPage({ ...validPage, status: "draft" })).toThrow(/status/i);
  });

  it.each(["2026-02-31", "2025-02-29", "2026-99-99", "2026-9-4", "yesterday"])(
    "rejects the impossible review date %s",
    (lastReviewed) => {
      expect(() => parsePublicPage({ ...validPage, lastReviewed })).toThrow(/lastReviewed/);
    }
  );

  it("accepts a leap day that exists", () => {
    expect(parsePublicPage({ ...validPage, lastReviewed: "2028-02-29" }).lastReviewed).toBe(
      "2028-02-29"
    );
  });

  it("requires source provenance instead of defaulting it", () => {
    const { relatedCode: _omitted, ...withoutProvenance } = validPage;
    expect(() => parsePublicPage(withoutProvenance)).toThrow(/relatedCode/);
    expect(() => parsePublicPage({ ...validPage, relatedCode: [] })).toThrow(/relatedCode/);
  });

  it.each([
    "/etc/passwd",
    "../outside.ts",
    "packages/../secrets.ts",
    "packages\\web\\a.ts",
    "C:/x",
  ])("rejects the non-repository source path %s", (path) => {
    expect(() => parsePublicPage({ ...validPage, relatedCode: [path] })).toThrow(/relatedCode/);
  });
});
