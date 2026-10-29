import { describe, expect, it } from "vitest";
import { isSignInFailureReason } from "./sign-in-failure";

describe("isSignInFailureReason", () => {
  it.each(["admission_denied", "github_email_permission_missing", "provider_unavailable"])(
    "recognizes %s",
    (reason) => {
      expect(isSignInFailureReason(reason)).toBe(true);
    }
  );

  it.each(["access_denied", "state_mismatch", ""])(
    "rejects Better Auth or unknown code %j",
    (code) => {
      expect(isSignInFailureReason(code)).toBe(false);
    }
  );
});
