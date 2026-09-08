import {
  ACTOR_HEADER,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  buildServiceAuthHeaders,
} from "@open-inspect/shared/service-auth";
import { dispatchControlPlaneFetch, getControlPlaneUrl } from "./control-plane-transport";

export interface WebServiceRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit | null;
  readonly traceId?: string;
  readonly correlationFields?: Record<string, string>;
  readonly transportOptions?: Omit<RequestInit, "method" | "headers" | "body">;
}

function getSignableBody(
  body: BodyInit | null | undefined
): ArrayBuffer | Uint8Array<ArrayBuffer> | string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof ArrayBuffer) {
    return body;
  }
  if (body instanceof Uint8Array) {
    const bytes = new Uint8Array(body.byteLength);
    bytes.set(body);
    return bytes;
  }
  throw new Error("Unsupported control-plane request body");
}

function sanitizeForwardedHeaders(headersInit: HeadersInit | undefined): Headers {
  const headers = new Headers(headersInit);
  // Only credentials minted at this boundary may identify a web-service request.
  headers.delete("Authorization");
  headers.delete(ACTOR_HEADER);
  headers.delete(SERVICE_HEADER);
  headers.delete(SERVICE_SIGNATURE_HEADER);
  return headers;
}

/**
 * Dispatch an exact request from the web service to the control plane.
 *
 * Callers decide which request data is safe to forward. This boundary removes
 * caller-supplied identity and signs the bytes that are actually dispatched.
 */
export async function dispatchWebServiceRequest(request: WebServiceRequest): Promise<Response> {
  const method = request.method.toUpperCase();
  const body = getSignableBody(request.body);
  const secret = process.env.SERVICE_AUTH_SECRET;
  if (!secret) {
    throw new Error("SERVICE_AUTH_SECRET not configured");
  }

  const url = `${getControlPlaneUrl()}${request.path}`;
  const headers = sanitizeForwardedHeaders(request.headers);

  const serviceHeaders = await buildServiceAuthHeaders({
    service: "web",
    secret,
    method,
    url,
    body,
    traceId: request.traceId,
  });
  for (const [name, value] of Object.entries(serviceHeaders)) {
    headers.set(name, value);
  }

  return dispatchControlPlaneFetch(
    url,
    {
      ...request.transportOptions,
      method,
      headers,
      body,
    },
    request.correlationFields ?? {}
  );
}
