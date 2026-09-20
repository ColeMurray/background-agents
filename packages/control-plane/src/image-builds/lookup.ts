/**
 * Spawn-time lookup composition: binds the lifecycle manager's
 * ImageBuildLookup port to the image-build subsystem (scope resolver + store).
 * The Durable Object only calls this factory and injects the result.
 */

import { ImageBuildStore } from "../db/image-builds";
import type { ImageBuildLookup } from "../sandbox/lifecycle/image-selection";
import type { ImageBuildProvider } from "./model";
import { resolveScopeEnabled } from "./scope";
import type { SqlDatabase } from "../db/sql-database";
import { DEFAULT_SANDBOX_EXECUTION_PROFILE } from "@open-inspect/shared/types/sandbox-execution";

export function createImageBuildLookup(
  db: SqlDatabase,
  provider: ImageBuildProvider
): ImageBuildLookup {
  const store = new ImageBuildStore(db);
  return {
    getLatestReady: async (scope, profile = DEFAULT_SANDBOX_EXECUTION_PROFILE) => {
      // Enablement (and entity existence) is the scope resolver's answer;
      // the store read is a plain row lookup.
      if (!(await resolveScopeEnabled(db, scope))) return null;
      return store.getLatestReadyForSpawn(scope, provider, profile);
    },
    markRestoreFailed: (imageBuildId, error) => store.markRestoreFailed(imageBuildId, error),
  };
}
