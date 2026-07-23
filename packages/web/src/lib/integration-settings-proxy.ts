import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

type ProxyMethod = "GET" | "PUT" | "DELETE";

const METHOD_VERBS: Record<ProxyMethod, string> = {
  GET: "fetch",
  PUT: "update",
  DELETE: "delete",
};

type RouteHandler<P> = (
  request: NextRequest,
  context: { params: Promise<P> }
) => Promise<NextResponse>;

/**
 * The GET/PUT/DELETE handler trio for a BFF route that proxies an
 * integration-settings scope (global, per-repo, per-environment) to the
 * control plane. Each scope's route file only supplies its control-plane path
 * (from already-decoded segments — encode them) and a label for error
 * messages; auth-first (session → 401 before any control-plane call), body
 * forwarding, and error translation live here once.
 */
export function integrationSettingsProxy<P>(
  buildPath: (params: P) => string,
  label: string
): { GET: RouteHandler<P>; PUT: RouteHandler<P>; DELETE: RouteHandler<P> } {
  const proxy = async (
    request: NextRequest,
    context: { params: Promise<P> },
    method: ProxyMethod
  ): Promise<NextResponse> => {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const params = await context.params;

    try {
      const response = await controlPlaneFetch(
        buildPath(params),
        method === "GET"
          ? undefined
          : {
              method,
              ...(method === "PUT" ? { body: JSON.stringify(await request.json()) } : {}),
            }
      );
      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    } catch (error) {
      console.error(`Failed to ${METHOD_VERBS[method]} ${label}:`, error);
      return NextResponse.json(
        { error: `Failed to ${METHOD_VERBS[method]} ${label}` },
        { status: 500 }
      );
    }
  };

  return {
    GET: (request, context) => proxy(request, context, "GET"),
    PUT: (request, context) => proxy(request, context, "PUT"),
    DELETE: (request, context) => proxy(request, context, "DELETE"),
  };
}
