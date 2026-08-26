import "server-only";

import { controlPlaneUserFetch } from "./control-plane";
import {
  sessionSnapshotSchema,
  type SessionSnapshot,
} from "@open-inspect/shared/types/server-messages";

export class SessionSnapshotError extends Error {
  constructor(readonly status: number) {
    super(`Session snapshot failed with status ${status}`);
    this.name = "SessionSnapshotError";
  }
}

export async function getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
  const response = await controlPlaneUserFetch(`/sessions/${encodeURIComponent(sessionId)}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new SessionSnapshotError(response.status);
  return sessionSnapshotSchema.parse(await response.json());
}
