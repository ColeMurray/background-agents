import type { Env } from "./types";

/** The session's page in the web app. */
export function sessionUrl(env: Env, sessionId: string): string {
  return `${env.WEB_APP_URL.replace(/\/$/, "")}/session/${sessionId}`;
}
