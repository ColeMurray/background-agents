import { describe, expect, it } from "vitest";

import { createGitSshSigSignedData } from "../../src/auth/sshsig";

describe("Git SSHSIG encoding", () => {
  it("constructs deterministic git-namespace signed data for the exact payload bytes", async () => {
    const payload = new TextEncoder().encode("commit payload\n");

    const signedData = await createGitSshSigSignedData(payload);

    expect(uint8ArrayToBase64(signedData)).toBe(
      "U1NIU0lHAAAAA2dpdAAAAAAAAAAGc2hhNTEyAAAAQNoq83jao15JABrZEbyP4tIDt2OZhqdtYjTWjwWY4kwVwG7U84ToXH4a6O6EqufziY5efEEryFgTeho5DlFkl9k="
    );
  });
});

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
