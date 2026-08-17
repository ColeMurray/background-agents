import { UserAuthConfigurationError } from "../auth/user/runtime";
import { createLogger } from "../logger";
import {
  defineRoutes,
  error,
  json,
  parsePattern,
  SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
  type Route,
} from "./shared";

const logger = createLogger("sign-in-providers");

const handleSignInProviders: Route["handler"] = async (_request, _env, _match, ctx) => {
  try {
    if (!ctx.getUserAuthRuntime) {
      throw new UserAuthConfigurationError("User authentication runtime is unavailable");
    }
    const response = json({
      providers: ctx.getUserAuthRuntime().enabledProviders,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (cause) {
    if (cause instanceof UserAuthConfigurationError) {
      logger.error("Sign-in provider configuration is unavailable", {
        event: "auth.providers.misconfigured",
        error: cause,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Sign-in providers are not configured", 503);
    }
    throw cause;
  }
};

export const signInProviderRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_WEB_SERVICE_ROUTE, [
  {
    method: "GET",
    pattern: parsePattern("/internal/auth/sign-in-providers"),
    handler: handleSignInProviders,
  },
]);
