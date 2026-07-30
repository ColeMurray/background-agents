import "server-only";

import { parseEnabledSignInProviders, type SignInProvider } from "@open-inspect/shared";
import { AuthenticationUnavailableError } from "./authentication-unavailable-error";
import { dispatchWebServiceRequest } from "./control-plane-service";
import { createLogger } from "./logger";
import { getCorrelationLogFields } from "./request-correlation";
import { getRequestCorrelation } from "./request-context";

const log = createLogger("sign-in-providers");
const SIGN_IN_PROVIDERS_PATH = "/internal/auth/sign-in-providers";

export async function getEnabledSignInProviders(): Promise<readonly SignInProvider[]> {
  const correlation = await getRequestCorrelation();
  const correlationFields = getCorrelationLogFields(correlation);

  try {
    const response = await dispatchWebServiceRequest({
      method: "GET",
      path: SIGN_IN_PROVIDERS_PATH,
      traceId: correlation.traceId,
      correlationFields,
      transportOptions: {
        redirect: "manual",
        cache: "no-store",
      },
    });
    if (!response.ok) {
      throw new Error(`Provider query failed with status ${response.status}`);
    }

    const payload: unknown = await response.json();
    return parseEnabledSignInProviders(payload).providers;
  } catch (cause) {
    log.error("auth.providers.fetch_failed", {
      ...correlationFields,
      event: "auth.providers.fetch_failed",
      http_path: SIGN_IN_PROVIDERS_PATH,
      error: cause instanceof Error ? cause : new Error(String(cause)),
    });
    throw new AuthenticationUnavailableError(cause);
  }
}
