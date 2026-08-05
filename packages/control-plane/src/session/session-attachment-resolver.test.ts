import { describe, expect, it } from "vitest";
import { parseStoredSessionAttachments } from "./session-attachment-resolver";

describe("parseStoredSessionAttachments", () => {
  it("normalizes a stored empty array to undefined", () => {
    expect(parseStoredSessionAttachments("[]")).toBeUndefined();
  });
});
