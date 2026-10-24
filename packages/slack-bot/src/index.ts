import app from "./app";
import { consumeSlackCompletions } from "./completion/consumer";
import { consumeSlackIngress } from "./ingress-consumer";
import { slackIngressJobSchema } from "./ingress-authority";

export default {
  fetch: app.fetch,
  queue(batch: MessageBatch<unknown>, env: Parameters<typeof consumeSlackCompletions>[1]) {
    return batch.messages.some((message) => slackIngressJobSchema.safeParse(message.body).success)
      ? consumeSlackIngress(batch, env)
      : consumeSlackCompletions(batch, env);
  },
};
