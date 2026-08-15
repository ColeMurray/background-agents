import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

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

async function proxyResponse(response: Response): Promise<NextResponse> {
  const text = await response.text();
  const init = {
    status: response.status,
    headers: { "Cache-Control": "private, no-store" },
  };
  return text ? NextResponse.json(JSON.parse(text), init) : new NextResponse(null, init);
}

/** Creates the requested BFF route handlers for an authenticated control-plane resource. */
export function settingsProxy<P>(
  buildPath: (params: P) => string,
  label: string
): ProxyHandlers<P> {
  const proxy = async (
    request: NextRequest,
    context: { params: Promise<P> },
    method: ProxyMethod
  ): Promise<NextResponse> => {
    const session = await getServerAuthSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const params = await context.params;

    try {
      // The revision ID is an opaque CAS token; forwarding it unchanged keeps
      // stale web editors from replacing content and assignments.
      const ifMatch = request.headers.get("if-match");
      let init: RequestInit | undefined;
      if (method !== "GET") {
        init = { method };
        if (method !== "DELETE") init.body = JSON.stringify(await request.json());
        if (ifMatch) init.headers = { "If-Match": ifMatch };
      }
      const response = await controlPlaneUserFetch(buildPath(params), init);
      return proxyResponse(response);
    } catch (error) {
      console.error(`Failed to ${METHOD_VERBS[method]} ${label}:`, error);
      return NextResponse.json(
        { error: `Failed to ${METHOD_VERBS[method]} ${label}` },
        { status: 500 }
      );
    }
  };

  const handler =
    (method: ProxyMethod): RouteHandler<P> =>
    (request, context) =>
      proxy(request, context, method);

  return {
    GET: handler("GET"),
    POST: handler("POST"),
    PATCH: handler("PATCH"),
    PUT: handler("PUT"),
    DELETE: handler("DELETE"),
  };
}
