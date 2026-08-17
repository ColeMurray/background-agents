import { describe, expect, it, vi } from "vitest";
import { createCloudflareBackgroundJobDispatcher } from "./background-job-dispatcher";

describe("createCloudflareBackgroundJobDispatcher", () => {
  it("extends the Durable Object lifetime for the submitted job", () => {
    const waitUntil = vi.fn();
    const dispatcher = createCloudflareBackgroundJobDispatcher({ waitUntil });
    const job = Promise.resolve();

    dispatcher.submit(job);

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(job);
  });
});
