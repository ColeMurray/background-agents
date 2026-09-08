import { runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import type { SessionRuntime } from "../../src/session/components";

/**
 * The DO internals integration tests are allowed to reach: the private
 * `runtime` accessor (which initializes on first touch) and the component
 * graph behind `SessionRuntime.internals`.
 *
 * NOTE: the `as unknown` cast below has no structural tie to SessionDO — its
 * members are private, so they cannot be `Pick`ed. Renaming the DO's
 * `runtime` accessor surfaces only as runtime TypeErrors across the
 * integration suite; keep this interface in sync with SessionDO by hand. The
 * `SessionRuntime` import does keep graph renames visible through
 * `tsconfig.integration.json`.
 */
export interface SessionDOInternals {
  runtime: SessionRuntime;
}

/**
 * `runInDurableObject` with the stub typed as the session DO. The production
 * `Env` deliberately leaves `SESSION` unparameterized (typing it would need
 * the adapter class, which sits behind the only-index-imports-it boundary),
 * so every test stub arrives as `DurableObjectStub<undefined>`. This seam is
 * the one place that asserts what the SESSION namespace actually hosts.
 * Callbacks that need storage use the `state` parameter — it is the same
 * object as the DO's protected `ctx`, supplied by the test API itself.
 */
export function runInSessionDO<R>(
  stub: DurableObjectStub,
  callback: (instance: SessionDO, state: DurableObjectState) => R | Promise<R>
): Promise<R> {
  return runInDurableObject(stub as unknown as DurableObjectStub<SessionDO>, callback);
}

/** Initialize (idempotent) and expose the DO's component graph. */
export function componentsOf(instance: SessionDO): SessionRuntime["internals"] {
  return (instance as unknown as SessionDOInternals).runtime.internals;
}

/**
 * Invoke the DO's real user-env resolver. The single place secrets tests
 * reach past SessionDO's encapsulation.
 */
export function getUserEnvVars(
  stub: DurableObjectStub
): Promise<Record<string, string> | undefined> {
  return runInSessionDO(stub, (instance) =>
    componentsOf(instance).userEnvResolver.getUserEnvVars()
  );
}
