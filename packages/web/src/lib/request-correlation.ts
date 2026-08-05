export const TRACE_ID_HEADER = "x-trace-id";
export const REQUEST_ID_HEADER = "x-request-id";
export const INTERNAL_REQUEST_ID_HEADER = "x-open-inspect-request-id";

const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REQUEST_ID_LENGTH = 8;

export interface RequestCorrelation {
  traceId: string;
  requestId: string;
}

export function createTraceId(): string {
  return crypto.randomUUID();
}

export function createRequestId(): string {
  return crypto.randomUUID().slice(0, REQUEST_ID_LENGTH);
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

export function resolveRequestId(value: string | null | undefined): string {
  return isValidRequestId(value) ? value : createRequestId();
}

export function getCorrelationLogFields(correlation: RequestCorrelation): Record<string, string> {
  return {
    trace_id: correlation.traceId,
    request_id: correlation.requestId,
  };
}

export function applyCorrelationHeaders(headers: Headers, correlation: RequestCorrelation): void {
  headers.set(TRACE_ID_HEADER, correlation.traceId);
  headers.set(REQUEST_ID_HEADER, correlation.requestId);
}
