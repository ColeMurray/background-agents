import { z } from "zod";

export const ADMISSION_POLICY_MAX_BODY_BYTES = 65_536;
export const MAX_MANAGED_ADMISSION_RULES = 50;
export const MAX_MANAGED_ADMISSION_ORGANIZATIONS = 10;

export interface AdmissionRules {
  allowedGitHubUsers: string[];
  allowedEmails: string[];
  allowedEmailDomains: string[];
  allowedGitHubOrganizations: string[];
}

export function emptyAdmissionRules(): AdmissionRules {
  return {
    allowedGitHubUsers: [],
    allowedEmails: [],
    allowedEmailDomains: [],
    allowedGitHubOrganizations: [],
  };
}

function normalize(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

/** Preserve deployment organization order for short-circuit membership checks. */
export function mergeAdmissionRules(
  deployment: { readonly [K in keyof AdmissionRules]: readonly string[] },
  managed: { readonly [K in keyof AdmissionRules]: readonly string[] }
): AdmissionRules {
  return {
    allowedGitHubUsers: normalize([
      ...deployment.allowedGitHubUsers,
      ...managed.allowedGitHubUsers,
    ]),
    allowedEmails: normalize([...deployment.allowedEmails, ...managed.allowedEmails]),
    allowedEmailDomains: normalize([
      ...deployment.allowedEmailDomains,
      ...managed.allowedEmailDomains,
    ]),
    allowedGitHubOrganizations: normalize([
      ...deployment.allowedGitHubOrganizations,
      ...managed.allowedGitHubOrganizations,
    ]),
  };
}

// Deployment rules retain legacy syntax; only managed input receives the stricter validators.
const looseList = z.array(z.string()).transform(normalize);
const looseRulesSchema = z.strictObject({
  allowedGitHubUsers: looseList,
  allowedEmails: looseList,
  allowedEmailDomains: looseList,
  allowedGitHubOrganizations: looseList,
});

const normalizedValue = z
  .string()
  .regex(/^[\x20-\x7e]*$/, "Use ASCII characters without control characters")
  .transform((value) => value.trim().toLowerCase());
const domainSchema = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Use an exact ASCII DNS hostname with at least two labels"
  )
  .refine((value) => !/^\d+(?:\.\d+)+$/.test(value), "IP literals are not allowed");
const loginSchema = normalizedValue.pipe(
  z
    .string()
    .max(39)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a bare GitHub login")
);
const emailSchema = normalizedValue
  .pipe(
    z
      .string()
      .max(254)
      .regex(
        /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[^@]+$/,
        "Use a single ASCII email address"
      )
  )
  .refine(
    (value) => domainSchema.safeParse(value.slice(value.lastIndexOf("@") + 1)).success,
    "Use an email address with an ASCII DNS domain"
  );
const managedList = (schema: z.ZodType<string>) =>
  z.array(schema).transform((values) => [...new Set(values)].sort());

export const admissionRulesSchema = z
  .strictObject({
    allowedGitHubUsers: managedList(loginSchema),
    allowedEmails: managedList(emailSchema),
    allowedEmailDomains: managedList(normalizedValue.pipe(domainSchema)),
    allowedGitHubOrganizations: managedList(loginSchema).refine(
      (values) => values.length <= MAX_MANAGED_ADMISSION_ORGANIZATIONS,
      `At most ${MAX_MANAGED_ADMISSION_ORGANIZATIONS} managed GitHub organizations are allowed`
    ),
  })
  .refine(
    (rules) =>
      Object.values(rules).reduce((total, values) => total + values.length, 0) <=
      MAX_MANAGED_ADMISSION_RULES,
    `At most ${MAX_MANAGED_ADMISSION_RULES} managed rules are allowed`
  );

const storedAdmissionPolicySchema = z.object({
  schema_version: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  rules_json: z.string(),
  updated_at: z.number().int().nonnegative().safe().nullable(),
  updated_by_user_id_snapshot: z.string().min(1).nullable(),
});

export interface StoredAdmissionPolicy {
  rules: AdmissionRules;
  rulesJson: string;
  revision: number;
  updatedAt: number | null;
  updatedByUserId: string | null;
}

/** Keep the original JSON for exact preimage fences, alongside normalized validated rules. */
export function parseStoredAdmissionPolicy(value: unknown): StoredAdmissionPolicy {
  const row = storedAdmissionPolicySchema.parse(value);
  return {
    rules: admissionRulesSchema.parse(JSON.parse(row.rules_json)),
    rulesJson: row.rules_json,
    revision: row.revision,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id_snapshot,
  };
}

export const admissionPolicySnapshotSchema = z.strictObject({
  deployment: looseRulesSchema,
  managed: admissionRulesSchema,
  effective: looseRulesSchema,
  revision: z.number().int().nonnegative().safe(),
  etag: z.string().min(1),
  updatedAt: z.number().int().nonnegative().safe().nullable(),
  updatedByUserId: z.string().min(1).nullable(),
  enabledProviders: z.array(z.enum(["github", "google"])),
  unsafeAllowAllUsers: z.boolean(),
  unsafeAllowAllEffective: z.boolean(),
  editingDisabledReason: z.enum(["unsafe_allow_all"]).nullable(),
});

export type AdmissionPolicySnapshot = z.infer<typeof admissionPolicySnapshotSchema>;
