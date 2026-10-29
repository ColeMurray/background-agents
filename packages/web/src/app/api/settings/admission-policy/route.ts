import { ADMISSION_POLICY_MAX_BODY_BYTES } from "@open-inspect/shared/admission-settings";
import { NextResponse } from "next/server";
import { PRIVATE_NO_STORE_HEADERS } from "@/lib/control-plane-json-proxy";
import { settingsProxy } from "@/lib/settings-proxy";

const proxy = settingsProxy(
  () => "/settings/admission-policy",
  "sign-in allowlist",
  {},
  { maxBodyBytes: ADMISSION_POLICY_MAX_BODY_BYTES }
);

export const GET = proxy.GET;

export const PUT: typeof proxy.PUT = (request, context) => {
  // Positive browser Fetch Metadata evidence only; Host/forwarded headers are not trusted origins.
  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    return Promise.resolve(
      NextResponse.json(
        { error: "Same-origin Fetch Metadata is required" },
        { status: 403, headers: PRIVATE_NO_STORE_HEADERS }
      )
    );
  }
  return proxy.PUT(request, context);
};
