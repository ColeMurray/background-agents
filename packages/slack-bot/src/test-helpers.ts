import type { ExecutionContext as HonoExecutionContext } from "hono";
import { vi } from "vitest";

export function makeExecutionContext() {
  return {
    props: {},
    waitUntil: vi.fn<HonoExecutionContext["waitUntil"]>(),
    passThroughOnException: vi.fn<HonoExecutionContext["passThroughOnException"]>(),
  } satisfies HonoExecutionContext;
}
