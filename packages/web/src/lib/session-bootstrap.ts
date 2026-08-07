import "server-only";

import {
  sessionBootstrapSchema,
  type SessionBootstrap,
} from "@open-inspect/shared/types/server-messages";
import { controlPlaneUserFetch } from "./control-plane";

export class SessionBootstrapError extends Error {
  constructor(readonly status: number) {
    super(`Session bootstrap failed with status ${status}`);
    this.name = "SessionBootstrapError";
  }
}

export async function getSessionBootstrap(sessionId: string): Promise<SessionBootstrap> {
  const response = await controlPlaneUserFetch(
    `/sessions/${encodeURIComponent(sessionId)}/bootstrap`,
    {
      cache: "no-store",
      headers: { Accept: "application/json" },
    }
  );
  if (!response.ok) throw new SessionBootstrapError(response.status);
  return sessionBootstrapSchema.parse(await response.json());
}
