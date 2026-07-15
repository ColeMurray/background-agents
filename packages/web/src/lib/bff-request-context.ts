import { headers } from "next/headers";
import {
  createBffRequestId,
  createTraceId,
  INTERNAL_BFF_REQUEST_ID_HEADER,
  resolveBffRequestId,
  resolveTraceId,
} from "./bff-correlation";
import type { BffCorrelation } from "./bff-correlation";

export async function getBffRequestCorrelation(): Promise<BffCorrelation> {
  try {
    const requestHeaders = await headers();
    return {
      traceId: resolveTraceId(requestHeaders.get("x-trace-id")),
      requestId: resolveBffRequestId(requestHeaders.get(INTERNAL_BFF_REQUEST_ID_HEADER)),
    };
  } catch {
    return {
      traceId: createTraceId(),
      requestId: createBffRequestId(),
    };
  }
}
