import { runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import type { SessionComponents } from "../../src/session/components";

/**
 * The DO internals integration tests are allowed to reach: the (private)
 * idempotent initializer and the component graph it builds. `Pick`-typed
 * casts tie each helper to the real types so a rename breaks the helper
 * instead of silently passing.
 */
export interface SessionDOInternals {
  ensureInitialized(rehydrateAlarm?: boolean): void;
  components: SessionComponents;
}

/** Initialize (idempotent) and expose the DO's component graph. */
export function componentsOf(instance: SessionDO): SessionComponents {
  const internals = instance as unknown as SessionDOInternals;
  internals.ensureInitialized();
  return internals.components;
}

/**
 * Invoke the DO's real user-env resolver. The single place secrets tests
 * reach past SessionDO's encapsulation.
 */
export function getUserEnvVars(
  stub: DurableObjectStub
): Promise<Record<string, string> | undefined> {
  return runInDurableObject(stub, (instance: SessionDO) =>
    componentsOf(instance).userEnvResolver.getUserEnvVars()
  );
}
