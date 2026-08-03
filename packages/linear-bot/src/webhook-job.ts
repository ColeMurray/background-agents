import { z } from "zod";
import type { AgentSessionWebhook, LinearWebhookJob } from "./types";

const agentSessionWebhookSchema = z.looseObject({
  type: z.string(),
  action: z.string(),
  organizationId: z.string(),
  appUserId: z.string(),
  webhookId: z.string(),
  agentSession: z.looseObject({ id: z.string() }),
});

export const linearWebhookJobSchema: z.ZodType<LinearWebhookJob> = z.object({
  version: z.literal(1),
  deliveryId: z.string().min(1),
  traceId: z.string().min(1),
  payload: agentSessionWebhookSchema as z.ZodType<AgentSessionWebhook>,
});
