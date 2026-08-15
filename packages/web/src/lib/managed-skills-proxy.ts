import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { getServerAuthSession } from "@/lib/server-auth-session";

type ProxyMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type RouteContext<P> = { params: Promise<P> };
type RouteHandler<P> = (request: NextRequest, context: RouteContext<P>) => Promise<NextResponse>;

async function responseData(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

export function managedSkillsProxy<P>(
  buildPath: (params: P) => string,
  label: string,
  methods: readonly ProxyMethod[]
): Partial<Record<ProxyMethod, RouteHandler<P>>> {
  const handlers: Partial<Record<ProxyMethod, RouteHandler<P>>> = {};

  for (const method of methods) {
    handlers[method] = async (request, context) => {
      const session = await getServerAuthSession();
      if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        const params = await context.params;
        const headers: Record<string, string> = {};
        const ifMatch = request.headers.get("if-match");
        if (ifMatch) headers["If-Match"] = ifMatch;

        const response = await controlPlaneUserFetch(buildPath(params), {
          method,
          ...(method !== "GET" && method !== "DELETE"
            ? { body: JSON.stringify(await request.json()) }
            : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
        });
        return NextResponse.json(await responseData(response), {
          status: response.status,
          headers: { "Cache-Control": "private, no-store" },
        });
      } catch (error) {
        console.error(`Failed to proxy ${label}:`, error);
        return NextResponse.json({ error: `Failed to ${label}` }, { status: 500 });
      }
    };
  }

  return handlers;
}
