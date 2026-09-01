import { CLI_CREDENTIAL_PATTERN } from "@open-inspect/shared/types/cli-auth";
import { hashToken } from "./crypto";
import { CliAuthStore } from "../db/cli-auth-store";
import type { RequestContext } from "../routes/shared";
import type { AuthResult } from "./result";

/** Authenticates a direct CLI bearer as its canonical human user, never as a service. */
export async function authenticateCliBearer(
  request: Request,
  ctx: RequestContext
): Promise<AuthResult> {
  const header = request.headers.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!CLI_CREDENTIAL_PATTERN.test(token)) {
    return { reason: "Unauthorized", status: 401, failedScheme: "cli-bearer" };
  }
  const credential = await new CliAuthStore(ctx.db).getActiveCredential(
    await hashToken(token),
    Date.now()
  );
  if (!credential) {
    return { reason: "Unauthorized", status: 401, failedScheme: "cli-bearer" };
  }
  return {
    principal: { kind: "user", userId: credential.userId },
    authentication: {
      mechanism: "cli_credential",
      credentialId: credential.id,
      expiresAt: credential.expiresAt,
      channel: { kind: "direct_bearer" },
    },
    request,
  };
}
