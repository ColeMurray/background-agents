import { z } from "zod";
import { isCanonicalUserId } from "../user-id";

export const CLI_EXTERNAL_API_V1_PATH = "/external/v1/cli";
export const CLI_DEVICE_SECRET_PATTERN = /^[0-9a-f]{64}$/;
export const CLI_CREDENTIAL_PATTERN = /^oi_cli_[0-9a-f]{64}$/;
export const CLI_USER_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const timestampSchema = z.number().int().nonnegative();
const credentialFields = {
  credential: z.string().regex(CLI_CREDENTIAL_PATTERN),
  credentialId: z.string().min(1),
  expiresAt: timestampSchema,
} as const;

export const startCliDeviceAuthorizationRequestSchema = z.strictObject({
  deviceName: z.string().trim().min(1).max(100),
});

export const startCliDeviceAuthorizationResponseSchema = z.strictObject({
  deviceSecret: z.string().regex(CLI_DEVICE_SECRET_PATTERN),
  userCode: z.string().regex(CLI_USER_CODE_PATTERN),
  verificationUrl: z.url(),
  expiresAt: timestampSchema,
  pollIntervalMs: z.number().int().positive(),
});

export const approveCliDeviceAuthorizationRequestSchema = z.strictObject({
  userCode: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .pipe(z.string().regex(CLI_USER_CODE_PATTERN)),
});

export const pendingCliDeviceAuthorizationResponseSchema = z.strictObject({
  deviceName: z.string().min(1).max(100),
  expiresAt: timestampSchema,
});

export const cliDeviceAuthorizationExchangeRequestSchema = z.strictObject({
  deviceSecret: z.string().regex(CLI_DEVICE_SECRET_PATTERN),
});

export const cliDeviceAuthorizationExchangeResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending"), expiresAt: timestampSchema }),
  z.strictObject({ status: z.literal("authorized"), ...credentialFields }),
]);

export const cliMeResponseSchema = z.strictObject({
  installation: z.strictObject({ name: z.string().min(1) }),
  user: z.strictObject({
    id: z.string().refine(isCanonicalUserId, "Invalid canonical user ID"),
    displayName: z.string().nullable(),
    email: z.string().nullable(),
  }),
  credential: z.strictObject({ id: z.string().min(1), expiresAt: timestampSchema }),
});

export type StartCliDeviceAuthorizationRequest = z.infer<
  typeof startCliDeviceAuthorizationRequestSchema
>;
export type StartCliDeviceAuthorizationResponse = z.infer<
  typeof startCliDeviceAuthorizationResponseSchema
>;
export type CliDeviceAuthorizationExchangeResponse = z.infer<
  typeof cliDeviceAuthorizationExchangeResponseSchema
>;
export type PendingCliDeviceAuthorizationResponse = z.infer<
  typeof pendingCliDeviceAuthorizationResponseSchema
>;
export type CliMeResponse = z.infer<typeof cliMeResponseSchema>;
