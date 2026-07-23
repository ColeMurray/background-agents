import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import {
  createRequestId,
  createTraceId,
  INTERNAL_REQUEST_ID_HEADER,
  resolveRequestId,
  resolveTraceId,
  TRACE_ID_HEADER,
} from "./request-correlation";
import type { RequestCorrelation } from "./request-correlation";

export async function getRequestCorrelation(): Promise<RequestCorrelation> {
  try {
    const requestHeaders = await headers();
    return {
      traceId: resolveTraceId(requestHeaders.get(TRACE_ID_HEADER)),
      requestId: resolveRequestId(requestHeaders.get(INTERNAL_REQUEST_ID_HEADER)),
    };
  } catch (error) {
    unstable_rethrow(error);
    return {
      traceId: createTraceId(),
      requestId: createRequestId(),
    };
  }
}
