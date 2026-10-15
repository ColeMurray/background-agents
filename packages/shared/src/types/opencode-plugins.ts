import { z } from "zod";
import { parseRepositoryFullName } from "./repositories";

/** Registry packages only: no floating versions, URLs, local paths or npm options. */
export const opencodePluginSpecSchema = z
  .string()
  .trim()
  .max(214)
  .regex(
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    "Use an npm package with an exact version, such as @company/audit@1.2.3"
  );
const repoScopeSchema = z
  .string()
  .trim()
  .refine((value) => parseRepositoryFullName(value) !== null, "Expected owner/repository")
  .transform((value) => value.toLowerCase());
export const opencodePluginInputSchema = z
  .object({
    spec: opencodePluginSpecSchema,
    repoScopes: z
      .array(repoScopeSchema)
      .min(1, "Select at least one repository")
      .nullable()
      .default(null),
    enabled: z.boolean().default(true),
  })
  .strict();
// Full edits carry the revision the editor read. A switch has authority only over enabled.
export const opencodePluginUpdateSchema = z.union([
  opencodePluginInputSchema.extend({ revision: z.number().int().positive() }),
  z.object({ enabled: z.boolean() }).strict(),
]);
export const opencodePluginSchema = opencodePluginInputSchema.extend({
  id: z.string(),
  revision: z.number().int().positive(),
});
export type OpencodePluginUpdate = z.infer<typeof opencodePluginUpdateSchema>;
export type OpencodePluginInput = z.infer<typeof opencodePluginInputSchema>;
export type OpencodePlugin = z.infer<typeof opencodePluginSchema>;
