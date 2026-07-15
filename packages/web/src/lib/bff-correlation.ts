export const TRACE_ID_HEADER = "x-trace-id";
export const REQUEST_ID_HEADER = "x-request-id";
export const INTERNAL_BFF_REQUEST_ID_HEADER = "x-open-inspect-bff-request-id";

const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const BFF_REQUEST_ID_LENGTH = 8;

export interface BffCorrelation {
  traceId: string;
  requestId: string;
}

export function createTraceId(): string {
  return crypto.randomUUID();
}

export function createBffRequestId(): string {
  return crypto.randomUUID().slice(0, BFF_REQUEST_ID_LENGTH);
}

export function isValidTraceId(value: string | null | undefined): value is string {
  return Boolean(value && TRACE_ID_PATTERN.test(value));
}

function isValidRequestId(value: string | null | undefined): value is string {
  return Boolean(value && REQUEST_ID_PATTERN.test(value));
}

export function resolveTraceId(value: string | null | undefined): string {
  return isValidTraceId(value) ? value : createTraceId();
}

export function resolveBffRequestId(value: string | null | undefined): string {
  return isValidRequestId(value) ? value : createBffRequestId();
}

export function getBffCorrelationLogFields(correlation: BffCorrelation): Record<string, string> {
  return {
    trace_id: correlation.traceId,
    request_id: correlation.requestId,
  };
}

export function applyBffCorrelationHeaders(headers: Headers, correlation: BffCorrelation): void {
  headers.set(TRACE_ID_HEADER, correlation.traceId);
  headers.set(REQUEST_ID_HEADER, correlation.requestId);
}
