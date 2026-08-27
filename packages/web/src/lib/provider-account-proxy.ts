import {
  MODEL_PROVIDER_ACCOUNT_ID_PATTERN,
  PROVIDER_DEVICE_AUTHORIZATION_ID_PATTERN,
  SUBSCRIPTION_PROVIDER_IDS,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { PRIVATE_NO_STORE_HEADERS } from "@/lib/control-plane-json-proxy";
import { settingsProxy } from "@/lib/settings-proxy";

export function validProviderAccountId(id: string): boolean {
  return MODEL_PROVIDER_ACCOUNT_ID_PATTERN.test(id);
}

export function validProviderDeviceAuthorizationId(id: string): boolean {
  return PROVIDER_DEVICE_AUTHORIZATION_ID_PATTERN.test(id);
}

export function validSubscriptionProvider(provider: string): provider is SubscriptionProviderId {
  return SUBSCRIPTION_PROVIDER_IDS.some((candidate) => candidate === provider);
}

function invalidProviderParameter(): NextResponse {
  return NextResponse.json(
    { error: "Invalid provider account parameter" },
    { status: 400, headers: PRIVATE_NO_STORE_HEADERS }
  );
}

export function providerAccountSettingsProxy<P>(
  buildPath: (params: P, request: NextRequest) => string,
  label: string,
  valid: (params: P) => boolean
) {
  const handlers = settingsProxy(buildPath, label);
  const handler =
    (method: keyof typeof handlers) =>
    async (request: NextRequest, context: { params: Promise<P> }) =>
      valid(await context.params) ? handlers[method](request, context) : invalidProviderParameter();

  return {
    GET: handler("GET"),
    POST: handler("POST"),
    PATCH: handler("PATCH"),
    PUT: handler("PUT"),
    DELETE: handler("DELETE"),
  };
}
