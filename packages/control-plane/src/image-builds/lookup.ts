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
import type { Env } from "../types";
import {
  daytonaBuildConfigurationKey,
  requireDaytonaBaseImage,
  resolveDaytonaResources,
} from "../sandbox/daytona-resources";
import { createLogger } from "../logger";

const logger = createLogger("image-builds:lookup");

export function createImageBuildLookup(
  env: Env,
  db: SqlDatabase,
  provider: ImageBuildProvider
): ImageBuildLookup {
  const store = new ImageBuildStore(db);
  return {
    getLatestReady: async (scope, sandboxSettings) => {
      // Enablement (and entity existence) is the scope resolver's answer;
      // the store read is a plain row lookup.
      if (!(await resolveScopeEnabled(db, scope))) return null;
      const row = await store.getLatestReadyForSpawn(scope, provider);
      if (provider !== "daytona" || !row) return row;
      const expected = daytonaBuildConfigurationKey(
        requireDaytonaBaseImage(env.DAYTONA_BASE_IMAGE),
        resolveDaytonaResources(sandboxSettings)
      );
      if (row.build_configuration_key !== expected) {
        logger.info("image_build.spawn_configuration_mismatch", {
          scope_kind: scope.kind,
          scope_id: scope.id,
          image_build_id: row.id,
        });
        return null;
      }
      return row;
    },
    markRestoreFailed: (imageBuildId, error) => store.markRestoreFailed(imageBuildId, error),
  };
}
