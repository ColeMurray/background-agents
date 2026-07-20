import { z } from "zod";

export const MAX_COMMIT_SIGNING_PRIVATE_KEY_LENGTH = 16_384;

const committerNameSchema = z.string().trim().min(1).max(256);
const committerEmailSchema = z.string().trim().email().max(320);
const timestampSchema = z.iso.datetime({ offset: true });

export const commitSigningWriteRequestSchema = z.strictObject({
  privateKey: z.string().min(1).max(MAX_COMMIT_SIGNING_PRIVATE_KEY_LENGTH),
  committerName: committerNameSchema,
  committerEmail: committerEmailSchema,
});

export type CommitSigningWriteRequest = z.infer<typeof commitSigningWriteRequestSchema>;

const disabledCommitSigningMetadataSchema = z.strictObject({
  enabled: z.literal(false),
});

const enabledCommitSigningMetadataSchema = z.strictObject({
  enabled: z.literal(true),
  committerName: committerNameSchema,
  committerEmail: committerEmailSchema,
  publicKey: z.string().startsWith("ssh-ed25519 "),
  fingerprint: z.string().startsWith("SHA256:"),
  updatedAt: timestampSchema,
});

export const commitSigningMetadataSchema = z.discriminatedUnion("enabled", [
  disabledCommitSigningMetadataSchema,
  enabledCommitSigningMetadataSchema,
]);

export type CommitSigningMetadata = z.infer<typeof commitSigningMetadataSchema>;
