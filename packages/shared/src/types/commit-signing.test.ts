import { describe, expect, it } from "vitest";
import { commitSigningMetadataSchema, commitSigningWriteRequestSchema } from ".";

describe("commit signing contracts", () => {
  it("parses enabled metadata and a write request", () => {
    const request = {
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n",
      committerName: "Open Inspect",
      committerEmail: "open-inspect@example.com",
    };
    const metadata = {
      enabled: true,
      committerName: "Open Inspect",
      committerEmail: "open-inspect@example.com",
      publicKey: "ssh-ed25519 AAAA example",
      fingerprint: "SHA256:example",
      updatedAt: "2026-07-16T12:00:00.000Z",
    };

    expect(commitSigningWriteRequestSchema.parse(request)).toEqual(request);
    expect(commitSigningMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(commitSigningMetadataSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });
});
