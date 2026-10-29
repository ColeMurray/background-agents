import { mergeAdmissionRules, type AdmissionRules } from "@open-inspect/shared/admission-settings";
import { createLogger } from "../../logger";
import {
  AdmissionPolicy,
  AdmissionUnavailableError,
  type AdmissionPolicyConfig,
} from "./admission-policy";

const logger = createLogger("auth:admission");

export async function resolveEffectiveAdmissionPolicy(
  deployment: AdmissionPolicyConfig,
  store: { get(): Promise<{ rules: AdmissionRules }> }
): Promise<AdmissionPolicy> {
  let managed: AdmissionRules;
  try {
    managed = (await store.get()).rules;
  } catch {
    // Store failures can contain policy data; never forward their cause to logs or callers.
    logger.error("Admission policy read failed", { event: "auth.admission_policy_read_failed" });
    throw new AdmissionUnavailableError();
  }
  return new AdmissionPolicy({
    ...mergeAdmissionRules(deployment, managed),
    unsafeAllowAllUsers: deployment.unsafeAllowAllUsers,
  });
}
