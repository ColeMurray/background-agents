import { z } from "zod";
import { repositoryPairInputSchema } from "@open-inspect/shared/types/repositories";

const secretsRecordSchema = z.custom<Record<string, string>>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string"),
  { message: "Secrets must be an object with string values" }
);

export const secretsRequestBodySchema = z.object({
  // Preserve every own key from JSON input, including `__proto__`. Zod's
  // record parser reconstructs the object and drops that key silently.
  secrets: secretsRecordSchema,
});

export const environmentSecretsImportBodySchema = repositoryPairInputSchema.extend({
  keys: z.array(z.string()).optional(),
});
