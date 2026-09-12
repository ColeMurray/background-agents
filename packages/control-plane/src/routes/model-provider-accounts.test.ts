import { describe, expect, it } from "vitest";
import type { ModelProviderAccountBrokerErrorCode } from "../auth/model-provider-account-broker";
import { modelProviderBrokerHttpStatus } from "./model-provider-accounts";

describe("modelProviderBrokerHttpStatus", () => {
  it.each([
    ["account_not_found", 404],
    ["upstream_retry_safe", 502],
    ["provider_unavailable", 503],
    ["exchange_busy", 503],
    ["account_inactive", 409],
    ["account_archived", 409],
    ["provider_mismatch", 409],
    ["credential_not_found", 409],
    ["credential_invalid", 409],
    ["reconnect_required", 409],
  ] satisfies Array<[ModelProviderAccountBrokerErrorCode, 404 | 409 | 502 | 503]>)(
    "maps %s to HTTP %i",
    (code, status) => {
      expect(modelProviderBrokerHttpStatus(code)).toBe(status);
    }
  );
});
