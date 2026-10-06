import type { NextRequest } from "next/server";
import { buildControlPlanePath } from "@/lib/control-plane-query";
import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  ({ id }: { id: string }, request: NextRequest) =>
    buildControlPlanePath(
      `/teams/${encodeURIComponent(id)}/sessions`,
      request.nextUrl.searchParams,
      ["bucket", "cursor"]
    ),
  "team sessions"
);
