import { headers } from "next/headers";
import {
  INTERNAL_REQUEST_ID_HEADER,
  resolveRequestId,
  resolveTraceId,
  TRACE_ID_HEADER,
} from "./request-correlation";
import type { RequestCorrelation } from "./request-correlation";

export async function getRequestCorrelation(): Promise<RequestCorrelation> {
  const requestHeaders = await headers();
  return {
    traceId: resolveTraceId(requestHeaders.get(TRACE_ID_HEADER)),
    requestId: resolveRequestId(requestHeaders.get(INTERNAL_REQUEST_ID_HEADER)),
  };
}
