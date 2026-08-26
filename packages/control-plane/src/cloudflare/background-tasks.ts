import { createLogger, type Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";

type WaitUntilContext = Pick<ExecutionContext, "waitUntil">;
const log = createLogger("background-tasks");

/** Keep Cloudflare event-lifetime extension at Worker and Durable Object boundaries. */
export function createCloudflareBackgroundTasks(
  context: WaitUntilContext,
  getLogger: () => Logger = () => log
): BackgroundTasks {
  return {
    submit(task, metadata): void {
      const logFailure = (error: unknown): void => {
        getLogger().error("background_task.failed", {
          task_name: metadata.name,
          ...metadata.context,
          error: error instanceof Error ? error : String(error),
        });
      };
      let pending: Promise<unknown>;
      try {
        pending = task();
      } catch (error) {
        logFailure(error);
        return; // Nothing started, so there is no lifetime to extend.
      }
      context.waitUntil(pending.catch(logFailure));
    },
  };
}
