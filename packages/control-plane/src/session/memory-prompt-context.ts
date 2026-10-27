import { z } from "zod";
import type { MemoryPromptContext } from "../memory/types";

/** The session runtime's answer to who a sandbox memory call is serving. */
export const memoryPromptContextSchema = z.object({
  authorUserId: z.string().nullable(),
  othersPrompted: z.boolean(),
}) satisfies z.ZodType<MemoryPromptContext>;
