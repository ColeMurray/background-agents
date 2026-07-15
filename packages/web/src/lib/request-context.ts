import { headers } from "next/headers";
import {
  createRequestId,
  createTraceId,
  INTERNAL_REQUEST_ID_HEADER,
  resolveRequestId,
  resolveTraceId,
} from "./request-correlation";
import type { RequestCorrelation } from "./request-correlation";

export async function getRequestCorrelation(): Promise<RequestCorrelation> {
  try {
    const requestHeaders = await headers();
    return {
      traceId: resolveTraceId(requestHeaders.get("x-trace-id")),
      requestId: resolveRequestId(requestHeaders.get(INTERNAL_REQUEST_ID_HEADER)),
    };
  } catch {
    return {
      traceId: createTraceId(),
      requestId: createRequestId(),
    };
  }
}
