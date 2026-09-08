import app from "./app";
import { consumeSlackCompletions } from "./completion/consumer";

export default {
  fetch: app.fetch,
  queue: consumeSlackCompletions,
};
