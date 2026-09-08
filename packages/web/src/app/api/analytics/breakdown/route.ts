import type { NextRequest } from "next/server";
import { buildControlPlanePath } from "@/lib/control-plane-query";
import { controlPlaneJsonGetProxy } from "@/lib/control-plane-json-proxy";

export const { GET } = controlPlaneJsonGetProxy(
  (request: NextRequest) =>
    buildControlPlanePath("/analytics/breakdown", new URL(request.url).searchParams, [
      "days",
      "by",
    ]),
  "analytics breakdown"
);
