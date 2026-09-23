import {
  linearCompletionCallbackPayloadSchema,
  type LinearCompletionCallback,
} from "@open-inspect/shared/types/session-api";
import { z } from "zod";

export const linearCompletionJobSchema = linearCompletionCallbackPayloadSchema.extend({
  deliveryId: z.string().min(1),
});

export type LinearCompletionJob = z.infer<typeof linearCompletionJobSchema>;

export function createLinearCompletionJob(payload: LinearCompletionCallback): LinearCompletionJob {
  const { signature: _, ...completion } = payload;
  return {
    ...completion,
    deliveryId: `linear:${payload.sessionId}:${payload.messageId}`,
  };
}
