import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  applyBffCorrelationHeaders,
  createBffRequestId,
  INTERNAL_BFF_REQUEST_ID_HEADER,
  resolveTraceId,
} from "@/lib/bff-correlation";

export function middleware(request: NextRequest) {
  const correlation = {
    traceId: resolveTraceId(request.headers.get("x-trace-id")),
    requestId: createBffRequestId(),
  };

  const requestHeaders = new Headers(request.headers);
  applyBffCorrelationHeaders(requestHeaders, correlation);
  requestHeaders.set(INTERNAL_BFF_REQUEST_ID_HEADER, correlation.requestId);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  applyBffCorrelationHeaders(response.headers, correlation);
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
