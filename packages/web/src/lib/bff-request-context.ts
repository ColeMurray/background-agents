import { headers } from "next/headers";
import {
  createBffRequestId,
  createTraceId,
  resolveBffRequestId,
  resolveTraceId,
} from "./bff-correlation";
import type { BffCorrelation } from "./bff-correlation";

export async function getBffRequestCorrelation(): Promise<BffCorrelation> {
  try {
    const requestHeaders = await headers();
    return {
      traceId: resolveTraceId(requestHeaders.get("x-trace-id")),
      requestId: resolveBffRequestId(requestHeaders.get("x-request-id")),
    };
  } catch {
    return {
      traceId: createTraceId(),
      requestId: createBffRequestId(),
    };
  }
}
