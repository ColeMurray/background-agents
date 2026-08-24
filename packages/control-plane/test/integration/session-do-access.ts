import { runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import type { UserEnvResolver } from "../../src/session/user-env-resolver";

/**
 * Invoke the DO's real (private) user-env resolver. The single place secrets
 * tests reach past SessionDO's encapsulation; `Pick` ties the cast to the real
 * class so a rename breaks this helper instead of silently passing.
 */
export function getUserEnvVars(
  stub: DurableObjectStub
): Promise<Record<string, string> | undefined> {
  return runInDurableObject(stub, (instance: SessionDO) =>
    (
      instance as unknown as {
        userEnvResolver: Pick<UserEnvResolver, "getUserEnvVars">;
      }
    ).userEnvResolver.getUserEnvVars()
  );
}
