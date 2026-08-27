import { githubAutofixSessionCommandSchema } from "@open-inspect/shared";
import type { Logger } from "../../../logger";
import type { SessionMessageQueue } from "../../message-queue";

type AutofixMessageQueue = Pick<SessionMessageQueue, "enqueueAutofix" | "lookupAutofix">;

/** HTTP boundary for internal Autofix commands. */
export class AutofixHandler {
  constructor(private readonly messageQueue: AutofixMessageQueue) {}

  async handle(request: Request, log: Logger): Promise<Response> {
    try {
      const result = githubAutofixSessionCommandSchema.safeParse(await request.json());
      if (!result.success) {
        return Response.json({ error: "Invalid Autofix command" }, { status: 400 });
      }
      if (result.data.type === "enqueue_feedback") {
        return Response.json(await this.messageQueue.enqueueAutofix(result.data));
      }
      return Response.json(await this.messageQueue.lookupAutofix(result.data.feedbackKey));
    } catch (error) {
      log.error("handleAutofix error", {
        error: error instanceof Error ? error : String(error),
      });
      throw error;
    }
  }
}
