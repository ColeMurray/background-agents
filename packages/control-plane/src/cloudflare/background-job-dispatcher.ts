import type { BackgroundJobDispatcher } from "../platform-ports";

type WaitUntilContext = Pick<ExecutionContext, "waitUntil">;

/** Keep Cloudflare event-lifetime extension at Worker and Durable Object boundaries. */
export function createCloudflareBackgroundJobDispatcher(
  context: WaitUntilContext
): BackgroundJobDispatcher {
  return {
    submit(job): void {
      context.waitUntil(job);
    },
  };
}
