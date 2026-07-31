import { z } from "zod";

export const spawnChildArgs = {
  reasoning: z
    .string()
    .optional()
    .describe(
      "Overrides the child's reasoning effort. Defaults to the parent's effort when omitted."
    ),
};

export function buildChildSpawnBody(args) {
  const body = { title: args.title, prompt: args.prompt };
  if (args.model) {
    body.model = args.model;
  }
  if (args.reasoning) {
    body.reasoningEffort = args.reasoning;
  }
  return body;
}
