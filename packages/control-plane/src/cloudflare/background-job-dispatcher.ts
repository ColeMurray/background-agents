import type { BackgroundJobDispatcher } from "../platform-ports";

type WaitUntilContext = Pick<DurableObjectState, "waitUntil">;

/** Keep Cloudflare event-lifetime extension at the Durable Object composition boundary. */
export function createCloudflareBackgroundJobDispatcher(
  context: WaitUntilContext
): BackgroundJobDispatcher {
  return {
    submit(job): void {
      context.waitUntil(job);
    },
  };
}
