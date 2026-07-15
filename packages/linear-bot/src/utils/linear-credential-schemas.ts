import { z } from "zod";

const nonEmptyString = z.string().min(1);
const responseScopeSchema = z.union([z.string(), z.array(z.string())]);
const safeIntegerSchema = z.number().int().refine(Number.isSafeInteger);

export const linearAuthorizationCodeAccessTokenSchema = z.object({
  access_token: nonEmptyString,
  token_type: nonEmptyString,
});

export const linearClientCredentialsTokenResponseSchema = z.object({
  access_token: nonEmptyString,
  token_type: nonEmptyString,
  expires_in: z.number().positive(),
  scope: responseScopeSchema.optional(),
});

export type LinearClientCredentialsTokenResponse = z.infer<
  typeof linearClientCredentialsTokenResponseSchema
>;

export const linearOAuthErrorResponseSchema = z.object({
  error: z
    .string()
    .transform((value) => value.slice(0, 100))
    .optional(),
});

export const linearIdentityResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      id: nonEmptyString,
      organization: z.object({
        id: nonEmptyString,
        name: nonEmptyString,
      }),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});

export const storedLinearClientCredentialsTokenSchema = z.object({
  version: z.literal(1),
  access_token: nonEmptyString,
  token_type: z.literal("Bearer"),
  scope: nonEmptyString,
  issued_at: safeIntegerSchema,
  expires_at: safeIntegerSchema,
  organization_id: nonEmptyString,
  organization_name: nonEmptyString,
  app_user_id: nonEmptyString,
});

export type StoredLinearClientCredentialsToken = z.infer<
  typeof storedLinearClientCredentialsTokenSchema
>;
