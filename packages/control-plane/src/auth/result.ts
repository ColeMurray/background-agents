import type { AuthenticationContext, Principal } from "./principal";

export interface AuthError {
  /** Response body message (also the log detail). Never carries token material. */
  reason: string;
  status: 401 | 413 | 500;
  /**
   * Which scheme was attempted and failed. A per-service attempt is terminal;
   * "none" means no recognized credential was presented at all, and the
   * router may still try sandbox auth on sandbox routes.
   */
  failedScheme: "per-service" | "browser-session" | "none";
}

export type AuthResult =
  | {
      principal: Principal;
      request: Request;
      authentication?: AuthenticationContext;
    }
  | AuthError;

export function isAuthError(result: AuthResult): result is AuthError {
  return !("principal" in result);
}
