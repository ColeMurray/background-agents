/**
 * Spawn-time lookup composition: binds the lifecycle manager's
 * ImageBuildLookup port to the image-build subsystem (scope resolver + store).
 * The Durable Object only calls this factory and injects the result.
 */

import { ImageBuildStore } from "../db/image-builds";
import { EnvironmentStore } from "../db/environments";
import { SessionIndexStore } from "../db/session-index";
import type { ImageBuildLookup } from "../sandbox/lifecycle/image-selection";
import type { ImageBuildProvider } from "./model";
import { resolveScopeEnabled } from "./scope";
import type { SqlDatabase } from "../db/sql-database";

export function createImageBuildLookup(
  db: SqlDatabase,
  provider: ImageBuildProvider,
  getSessionId: () => string
): ImageBuildLookup {
  const store = new ImageBuildStore(db);
  return {
    getLatestReady: async (scope) => {
      if (scope.kind === "environment") {
        const environment = await new EnvironmentStore(db).getById(scope.id);
        if (environment?.prebuild_enabled !== 1) return null;
        // Environment images may contain their owner's secrets in baked files.
        if (environment.owner_team_id !== null) {
          const session = await new SessionIndexStore(db).get(getSessionId());
          if (!session || session.ownerTeamId !== environment.owner_team_id) return null;
        }
      } else if (!(await resolveScopeEnabled(db, scope))) return null;
      return store.getLatestReadyForSpawn(scope, provider);
    },
    markRestoreFailed: (imageBuildId, error) => store.markRestoreFailed(imageBuildId, error),
  };
}
