import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { commitSigningMetadataSchema } from "@open-inspect/shared";

import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function response(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: NO_STORE_HEADERS });
}

async function authorized(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  return Boolean(session?.user);
}

async function proxy(
  method: "GET" | "PUT" | "DELETE",
  request?: NextRequest
): Promise<NextResponse> {
  if (!(await authorized())) return response({ error: "Unauthorized" }, 401);

  let body: unknown;
  if (method === "PUT") {
    try {
      body = await request?.json();
    } catch {
      return response({ error: "Invalid JSON body" }, 400);
    }
  }

  try {
    const controlPlaneResponse = await controlPlaneFetch(
      "/commit-signing",
      method === "GET"
        ? undefined
        : {
            method,
            ...(method === "PUT" ? { body: JSON.stringify(body) } : {}),
          }
    );
    const payload: unknown = await controlPlaneResponse.json();
    if (!controlPlaneResponse.ok) {
      return response(
        {
          error:
            controlPlaneResponse.status === 400
              ? "Invalid commit signing configuration"
              : "Commit signing request failed",
        },
        controlPlaneResponse.status
      );
    }

    const metadata = commitSigningMetadataSchema.safeParse(payload);
    if (!metadata.success) {
      return response({ error: "Invalid commit signing service response" }, 502);
    }
    return response(metadata.data, controlPlaneResponse.status);
  } catch {
    return response({ error: "Commit signing service unavailable" }, 500);
  }
}

export async function GET(): Promise<NextResponse> {
  return proxy("GET");
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  return proxy("PUT", request);
}

export async function DELETE(): Promise<NextResponse> {
  return proxy("DELETE");
}
