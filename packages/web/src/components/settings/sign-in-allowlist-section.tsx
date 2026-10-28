"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  admissionRulesSchema,
  MAX_MANAGED_ADMISSION_RULES,
  type AdmissionRules,
} from "@open-inspect/shared/admission-settings";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAdmissionPolicy } from "@/hooks/use-admission-policy";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { ADMISSION_RULE_GROUPS, AdmissionRuleGroups } from "./admission-rule-groups";
import { SettingsCardSection } from "./settings-card-section";
import { SignInAllowlistReview } from "./sign-in-allowlist-review";

export function SignInAllowlistSection() {
  const policy = useAdmissionPolicy();
  const { hasPermission } = useCurrentUserAuthorization();
  const [type, setType] = useState<keyof AdmissionRules>("allowedEmails");
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const group = ADMISSION_RULE_GROUPS.find((candidate) => candidate.key === type)!;
  const { snapshot, draft, changes } = policy;
  const dirty = changes.length > 0 || value.length > 0;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function addRule() {
    if (!draft || !policy.canEdit) return;
    const parsed = admissionRulesSchema.safeParse({ ...draft, [type]: [...draft[type], value] });
    if (!parsed.success) {
      setValidationError(parsed.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    policy.setDraft(parsed.data);
    setValue("");
    setValidationError(null);
  }

  return (
    <SettingsCardSection
      title="Sign-in allowlist"
      description="Allow sign-in when any rule matches (OR). Deployment and settings rules are combined. These rules do not assign roles or suspend existing members."
    >
      <div ref={panel} tabIndex={-1} className="space-y-5">
        {policy.error && <ErrorBanner role="alert">{policy.error}</ErrorBanner>}
        {policy.notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {policy.notice}
          </p>
        )}
        {policy.loading && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading sign-in allowlist...
          </p>
        )}
        {policy.denied && (
          <p role="status" className="text-sm text-muted-foreground">
            An active Owner or Administrator role is required to manage sign-in rules.
          </p>
        )}
        {!policy.denied && !policy.loading && (!snapshot || policy.needsReload) && (
          <Button variant="outline" onClick={() => void policy.reload()}>
            {snapshot ? "Reload current rules for review" : "Retry"}
          </Button>
        )}
        {snapshot && draft && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Configured sign-in providers:</span>
              {snapshot.enabledProviders.map((provider) => (
                <span
                  key={provider}
                  className="rounded-full border border-border px-2 py-1 text-foreground"
                >
                  {provider === "github" ? "GitHub" : "Google"}
                </span>
              ))}
              {!snapshot.enabledProviders.length && <span>None configured</span>}
            </div>
            <p className="text-sm text-muted-foreground">
              Email rules require verified provider evidence. GitHub sign-in requires a verified
              email even when a username or organization matches. New users receive the default
              Member role; linked users retain their role. These rules do not undo suspension or
              configure bot access.
            </p>
            {!snapshot.enabledProviders.includes("github") && (
              <p className="text-sm text-muted-foreground">
                GitHub sign-in is not configured. GitHub username and organization rules do not
                admit Google identities.
              </p>
            )}
            {snapshot.unsafeAllowAllUsers && (
              <div
                role="status"
                className="rounded-md border border-border p-3 text-sm text-muted-foreground"
              >
                <p>
                  Unsafe allow-all is{" "}
                  {snapshot.unsafeAllowAllEffective
                    ? "effective: any otherwise valid provider identity can sign in"
                    : "configured but dormant behind nonempty rules"}
                  .
                </p>
                <p className="mt-2">
                  Disable unsafe allow-all and configure a recovery sign-in rule in your deployment
                  before editing the allowlist here.
                </p>
              </div>
            )}
            {snapshot.editingDisabledReason === "maintenance" && (
              <p
                role="status"
                className="rounded-md border border-border p-3 text-sm text-muted-foreground"
              >
                Editing is disabled for operator-managed maintenance. An operator must enable
                editing after deployment is complete; reloading cannot enable it.
              </p>
            )}
            {Object.values(draft).every((values) => values.length === 0) && (
              <p className="text-sm text-muted-foreground">
                No rules added in settings; deployment rules still apply.
              </p>
            )}
            {changes.length > 0 && (
              <p className="text-sm font-medium text-foreground">
                Previewing deployment and draft settings rules. Changes do not apply until saved.
              </p>
            )}
            <AdmissionRuleGroups
              deployment={snapshot.deployment}
              draft={draft}
              disabled={!policy.canEdit}
              onChange={policy.setDraft}
            />
            {!snapshot.editingDisabledReason && !snapshot.unsafeAllowAllUsers && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  addRule();
                }}
                className="space-y-3 rounded-md border border-border p-4"
              >
                <h4 className="text-sm font-medium text-foreground">Add a settings rule</h4>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
                  <div className="min-w-0 space-y-1.5">
                    <label htmlFor={`${inputId}-type`} className="text-xs text-muted-foreground">
                      Rule type
                    </label>
                    <Select
                      value={type}
                      disabled={!policy.canEdit}
                      onValueChange={(next) => {
                        setType(next as keyof AdmissionRules);
                        setValidationError(null);
                      }}
                    >
                      <SelectTrigger id={`${inputId}-type`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ADMISSION_RULE_GROUPS.map((item) => (
                          <SelectItem key={item.key} value={item.key}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="min-w-0 space-y-1.5">
                    <label htmlFor={inputId} className="text-xs text-muted-foreground">
                      {group.label}
                    </label>
                    <Input
                      id={inputId}
                      value={value}
                      disabled={!policy.canEdit}
                      placeholder={group.placeholder}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      aria-invalid={!!validationError}
                      aria-describedby={`${inputId}-help`}
                      onChange={(event) => {
                        setValue(event.target.value);
                        setValidationError(null);
                      }}
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={!policy.canEdit || !value.trim()}
                  >
                    Add rule
                  </Button>
                </div>
                <p id={`${inputId}-help`} className="text-xs text-muted-foreground">
                  {group.help} Use ASCII values (punycode for international domains), without
                  wildcards. Up to {MAX_MANAGED_ADMISSION_RULES} settings rules total.
                </p>
                {validationError && (
                  <p role="alert" className="text-sm text-destructive">
                    {validationError}
                  </p>
                )}
              </form>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                ref={reviewTrigger}
                disabled={!policy.canEdit || !changes.length || !!value}
                onClick={() => setReviewOpen(true)}
              >
                {policy.saving ? "Saving..." : "Review and save"}
              </Button>
              <Button
                variant="outline"
                disabled={!dirty || policy.saving || policy.loading}
                onClick={() => {
                  if (!window.confirm("Discard unsaved sign-in allowlist changes?")) return;
                  policy.discard();
                  setValue("");
                  setValidationError(null);
                }}
              >
                Cancel
              </Button>
              <span role="status" className="text-xs text-muted-foreground">
                {dirty
                  ? `Unsaved changes: ${changes.filter(({ action }) => action === "Add").length} added, ${changes.filter(({ action }) => action === "Remove").length} removed${value ? "; add or clear the entered value before saving" : ""}.`
                  : "No unsaved changes"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Applies to future sign-in and other operations that recheck sign-in eligibility.
              Removing a rule does not revoke existing sessions. Use{" "}
              <a href="#workspace-members" className="underline">
                Members &gt; Suspend
              </a>{" "}
              to revoke a member&apos;s access.
              {hasPermission("workspace.audit.read") && (
                <>
                  {" "}
                  Changes are recorded in the{" "}
                  <a href="/settings?tab=audit-log" className="underline">
                    Audit log
                  </a>
                  .
                </>
              )}{" "}
              After a deployment rollout, reload this page to verify the settled deployment rules.
            </p>
            <SignInAllowlistReview
              open={reviewOpen && policy.canEdit}
              onOpenChange={setReviewOpen}
              snapshot={snapshot}
              draft={draft}
              onSave={() => void policy.save()}
              onCloseFocus={() => {
                const target = reviewTrigger.current;
                if (target && !target.disabled) target.focus();
                else panel.current?.focus();
              }}
            />
          </>
        )}
      </div>
    </SettingsCardSection>
  );
}
