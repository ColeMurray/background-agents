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
      context.waitUntil(
        task.catch((error) => {
          getLogger().error("background_task.failed", {
            task_name: metadata.name,
            ...metadata.context,
            error: error instanceof Error ? error : String(error),
          });
        })
      );
    },
  };
}
