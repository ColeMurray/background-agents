import type {
  GitHubAutofixSessionCommand,
  GitHubAutofixSessionResponse,
} from "@open-inspect/shared";
import type { SessionMessageQueue } from "../message-queue";

export class SessionAutofixService {
  constructor(private readonly messageQueue: SessionMessageQueue) {}

  handle(command: GitHubAutofixSessionCommand): Promise<GitHubAutofixSessionResponse> {
    if (command.type === "enqueue_feedback") {
      return this.messageQueue.enqueueAutofix(command);
    }

    return this.messageQueue.lookupAutofix(command.feedbackKey);
  }
}
