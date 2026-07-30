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

function resolveControlPlaneRequestUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("Control-plane request path must be an absolute path");
  }
  if (path.startsWith("//")) {
    throw new Error("Control-plane request path must start with exactly one slash");
  }
  if (path.includes("\\")) {
    throw new Error("Control-plane request path must not include backslashes");
  }
  if (path.includes("#")) {
    throw new Error("Control-plane request path must not include a fragment");
  }
  if (/%5c/i.test(path)) {
    throw new Error("Control-plane request path must not include encoded backslashes");
  }

  const controlPlaneUrl = new URL(getControlPlaneUrl());
  const requestUrl = new URL(path, controlPlaneUrl);
  if (requestUrl.username || requestUrl.password) {
    throw new Error("Control-plane URL must not include credentials");
  }
  if (requestUrl.origin !== controlPlaneUrl.origin) {
    throw new Error("Control-plane request path must stay on the configured origin");
  }
  return requestUrl.href;
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

  const url = resolveControlPlaneRequestUrl(request.path);
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
