import { readBodyCapped } from "@open-inspect/shared/http-body";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { serializeBrowserSessionCookies } from "@/lib/browser-session-cookie";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { relayJsonResponse } from "@/lib/control-plane-json-proxy";

type ProxyMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const METHOD_VERBS: Record<ProxyMethod, string> = {
  GET: "fetch",
  POST: "create",
  PATCH: "update",
  PUT: "update",
  DELETE: "delete",
};

type RouteHandler<P> = (
  request: NextRequest,
  context: { params: Promise<P> }
) => Promise<NextResponse>;

type ProxyHandlers<P> = Record<ProxyMethod, RouteHandler<P>>;

/** JSON mutation budget kept below portable web-function request limits. */
export const SETTINGS_PROXY_MAX_BODY_BYTES = 4 * 1024 * 1024;

async function readMutationBody(request: NextRequest): Promise<Uint8Array | null> {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > SETTINGS_PROXY_MAX_BODY_BYTES) return null;
  return readBodyCapped(request.body, SETTINGS_PROXY_MAX_BODY_BYTES);
}

async function relaySettingsResource(
  request: NextRequest,
  buildPath: () => string | Promise<string>,
  label: string,
  method: ProxyMethod
): Promise<NextResponse> {
  try {
    // The revision ID is an opaque CAS token; forwarding it unchanged keeps
    // stale web editors from replacing content and assignments.
    const ifMatch = request.headers.get("if-match");
    let init: RequestInit | undefined;
    if (method !== "GET") {
      init = { method };
      if (method !== "DELETE") {
        const cookieHeader = serializeBrowserSessionCookies(request.cookies.getAll());
        if (!cookieHeader) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const body = await readMutationBody(request);
        if (!body) {
          return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
        }
        init.body = new TextDecoder().decode(body);
      }
      if (ifMatch) init.headers = { "If-Match": ifMatch };
    }
    const response = await controlPlaneUserFetch(await buildPath(), init);
    return relayJsonResponse(response);
  } catch (error) {
    console.error(`Failed to ${METHOD_VERBS[method]} ${label}:`, error);
    return NextResponse.json(
      { error: `Failed to ${METHOD_VERBS[method]} ${label}` },
      { status: 500 }
    );
  }
}

/** Creates the requested BFF route handlers for an authenticated control-plane resource. */
export function settingsProxy<P>(
  buildPath: (params: P, request: NextRequest) => string,
  label: string
): ProxyHandlers<P> {
  const handler =
    (method: ProxyMethod): RouteHandler<P> =>
    (request, context) =>
      relaySettingsResource(
        request,
        async () => buildPath(await context.params, request),
        label,
        method
      );

  return {
    GET: handler("GET"),
    POST: handler("POST"),
    PATCH: handler("PATCH"),
    PUT: handler("PUT"),
    DELETE: handler("DELETE"),
  };
}
