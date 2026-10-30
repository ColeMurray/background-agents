import { NextResponse } from "next/server";
import { PRIVATE_NO_STORE_HEADERS } from "@/lib/control-plane-json-proxy";
import { settingsProxy } from "@/lib/settings-proxy";

const proxy = settingsProxy(
  () => "/settings/personal-access-token-policy",
  "personal access token policy"
);

export const GET = proxy.GET;

export const PUT: typeof proxy.PUT = (request, context) => {
  // The policy can switch off every token in the workspace, so it changes only from this app's
  // own pages: positive browser Fetch Metadata evidence, as the sign-in allowlist requires.
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
