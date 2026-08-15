import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

type ProxyMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const DEFAULT_METHODS = ["GET", "PUT", "DELETE"] as const;

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

type ProxyHandlers<P, M extends readonly ProxyMethod[]> = {
  [Method in M[number]]: RouteHandler<P>;
};

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
): ProxyHandlers<P, typeof DEFAULT_METHODS>;
export function settingsProxy<P, const M extends readonly ProxyMethod[]>(
  buildPath: (params: P) => string,
  label: string,
  methods: M
): ProxyHandlers<P, M>;
export function settingsProxy<P, const M extends readonly ProxyMethod[]>(
  buildPath: (params: P) => string,
  label: string,
  methods: M = DEFAULT_METHODS as unknown as M
): ProxyHandlers<P, M> {
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
      const ifMatch = request.headers.get("if-match");
      const response = await controlPlaneUserFetch(
        buildPath(params),
        method === "GET"
          ? undefined
          : {
              method,
              ...(method !== "DELETE" ? { body: JSON.stringify(await request.json()) } : {}),
              ...(ifMatch ? { headers: { "If-Match": ifMatch } } : {}),
            }
      );
      return proxyResponse(response);
    } catch (error) {
      console.error(`Failed to ${METHOD_VERBS[method]} ${label}:`, error);
      return NextResponse.json(
        { error: `Failed to ${METHOD_VERBS[method]} ${label}` },
        { status: 500 }
      );
    }
  };

  return Object.fromEntries(
    methods.map((method) => [
      method,
      (request: NextRequest, context: { params: Promise<P> }) => proxy(request, context, method),
    ])
  ) as ProxyHandlers<P, M>;
}
