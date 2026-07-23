import { describe, expect, it } from "vitest";
import { isCanonicalUserId } from "./user-id";

describe("canonical user IDs", () => {
  it("accepts generated 32-character lowercase hex IDs", () => {
    expect(isCanonicalUserId("0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("rejects non-canonical values", () => {
    expect(isCanonicalUserId("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(isCanonicalUserId("0123456789abcdef")).toBe(false);
    expect(isCanonicalUserId("user-1")).toBe(false);
    expect(isCanonicalUserId(null)).toBe(false);
  });
});
