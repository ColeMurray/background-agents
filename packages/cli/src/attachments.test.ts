import { describe, expect, it } from "vitest";
import { validateAttachmentBytes } from "./attachments.js";

describe("validateAttachmentBytes", () => {
  it("accepts WebP signatures when binary size bytes form a UTF-8 sequence", () => {
    const bytes = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0xc2, 0xb8, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);

    expect(() => validateAttachmentBytes(bytes, "image.webp")).not.toThrow();
  });
});
