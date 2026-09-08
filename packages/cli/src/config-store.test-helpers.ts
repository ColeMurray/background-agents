import { randomBytes, randomUUID } from "node:crypto";
import { CredentialLifecycle } from "./credential-lifecycle.js";
import type { ConfigStore, StoredContext } from "./config-store.js";

/** Seed tests through the same staging, promotion, and cleanup path as login. */
export async function seedContext(store: ConfigStore, name: string, context: StoredContext) {
  const lifecycle = new CredentialLifecycle(store, async () => new Response(null, { status: 204 }));
  const deviceSecretRef = await lifecycle.stageDeviceAuthorization({
    url: context.url,
    contextName: name,
    deviceSecret: randomBytes(32).toString("hex"),
  });
  return lifecycle.install(name, { ...context, credentialId: randomUUID() }, deviceSecretRef);
}
