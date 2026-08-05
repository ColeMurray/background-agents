import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  applyCorrelationHeaders,
  createRequestId,
  INTERNAL_REQUEST_ID_HEADER,
  resolveTraceId,
} from "@/lib/request-correlation";

export function middleware(request: NextRequest) {
  const correlation = {
    traceId: resolveTraceId(request.headers.get("x-trace-id")),
    requestId: createRequestId(),
  };

  const requestHeaders = new Headers(request.headers);
  applyCorrelationHeaders(requestHeaders, correlation);
  requestHeaders.set(INTERNAL_REQUEST_ID_HEADER, correlation.requestId);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  applyCorrelationHeaders(response.headers, correlation);
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
