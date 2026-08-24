import { runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import type { SessionComponents } from "../../src/session/components";

/**
 * The DO internals integration tests are allowed to reach: the (private)
 * idempotent initializer and the component graph it builds.
 *
 * NOTE: `test/integration/**` is never typechecked (eslint + grep are the only
 * static gates here), and the `as unknown` cast below has no structural tie to
 * SessionDO — its members are private, so they cannot be `Pick`ed. Renaming
 * `ensureInitialized` or `components` on the DO surfaces only as runtime
 * TypeErrors across the integration suite; keep this interface in sync with
 * SessionDO by hand. The `SessionComponents` import does keep component-graph
 * renames visible, but in-editor only.
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
