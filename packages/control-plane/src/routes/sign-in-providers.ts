import { Hono } from "hono";
import { UserAuthConfigurationError } from "../auth/user/runtime";
import { createLogger } from "../logger";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { error, json, NO_AUTHORIZATION, SCM_AGNOSTIC_WEB_SERVICE_ROUTE } from "./shared";

const logger = createLogger("sign-in-providers");

export const signInProviderRoutes = new Hono<ControlPlaneHonoEnv>();

signInProviderRoutes.get(
  "/internal/auth/sign-in-providers",
  admit({ ...SCM_AGNOSTIC_WEB_SERVICE_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => {
    const { ctx } = c.var.admitted;
    try {
      if (!ctx.getUserAuthRuntime) {
        throw new UserAuthConfigurationError("User authentication runtime is unavailable");
      }
      const response = json({ providers: ctx.getUserAuthRuntime().enabledProviders });
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
  }
);
