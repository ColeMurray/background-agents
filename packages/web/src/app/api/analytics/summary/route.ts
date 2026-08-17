import type { NextRequest } from "next/server";
import { buildControlPlanePath } from "@/lib/control-plane-query";
import { jsonResourceProxy } from "@/lib/settings-proxy";

export const { GET } = jsonResourceProxy(
  (request: NextRequest) =>
    buildControlPlanePath("/analytics/summary", new URL(request.url).searchParams, ["days"]),
  "analytics summary"
);
