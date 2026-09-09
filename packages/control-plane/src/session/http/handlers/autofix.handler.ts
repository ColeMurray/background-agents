import {
  githubAutofixSessionCommandSchema,
  type GitHubAutofixSessionCommand,
  type GitHubAutofixSessionResponse,
} from "@open-inspect/shared";
import type { Logger } from "../../../logger";

type EnqueueAutofixCommand = Extract<GitHubAutofixSessionCommand, { type: "enqueue_feedback" }>;
type EnqueueAutofixResponse = Extract<
  GitHubAutofixSessionResponse,
  { kind: "enqueued" | "duplicate" | "rejected" }
>;
type LookupAutofixResponse = Extract<GitHubAutofixSessionResponse, { kind: "found" | "not_found" }>;

interface AutofixMessageQueue {
  enqueueAutofix(command: EnqueueAutofixCommand): Promise<EnqueueAutofixResponse>;
  lookupAutofix(feedbackKey: string): Promise<LookupAutofixResponse>;
}

/** HTTP boundary for internal Autofix commands. */
export class AutofixHandler {
  constructor(private readonly messageQueue: AutofixMessageQueue) {}

  async handle(request: Request, log: Logger): Promise<Response> {
    try {
      const result = githubAutofixSessionCommandSchema.safeParse(await request.json());
      if (!result.success) {
        return Response.json({ error: "Invalid Autofix command" }, { status: 400 });
      }
      switch (result.data.type) {
        case "enqueue_feedback":
          return Response.json(await this.messageQueue.enqueueAutofix(result.data));
        case "lookup_feedback":
          return Response.json(await this.messageQueue.lookupAutofix(result.data.feedbackKey));
        default:
          return result.data satisfies never;
      }
    } catch (error) {
      log.error("handleAutofix error", {
        error: error instanceof Error ? error : String(error),
      });
      throw error;
    }
  }
}
