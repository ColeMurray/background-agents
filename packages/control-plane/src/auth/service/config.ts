import type { ServiceName } from "@open-inspect/shared/service-auth";

/** The per-service verification keys held by the control plane. */
export interface ServiceKeyEnv {
  SERVICE_AUTH_SECRET_WEB?: string;
  SERVICE_AUTH_SECRET_SLACK_BOT?: string;
  SERVICE_AUTH_SECRET_GITHUB_BOT?: string;
  SERVICE_AUTH_SECRET_LINEAR_BOT?: string;
  SERVICE_AUTH_SECRET_MODAL?: string;
}

/** Resolve the verification key for one authenticated service. */
export function serviceAuthSecret(env: ServiceKeyEnv, service: ServiceName): string | undefined {
  switch (service) {
    case "web":
      return env.SERVICE_AUTH_SECRET_WEB;
    case "slack-bot":
      return env.SERVICE_AUTH_SECRET_SLACK_BOT;
    case "github-bot":
      return env.SERVICE_AUTH_SECRET_GITHUB_BOT;
    case "linear-bot":
      return env.SERVICE_AUTH_SECRET_LINEAR_BOT;
    case "modal":
      return env.SERVICE_AUTH_SECRET_MODAL;
  }
}
