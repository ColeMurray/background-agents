"use client";

import { useId, useRef, useState } from "react";
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
import { useSettingsUnsavedChanges } from "./settings-navigation-guard";

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

  useSettingsUnsavedChanges(dirty);

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
      description="Any matching rule allows access. Deployment rules are read-only."
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
            Loading rules...
          </p>
        )}
        {policy.denied && (
          <p role="status" className="text-sm text-muted-foreground">
            Only Owners and Administrators can edit these rules.
          </p>
        )}
        {!policy.denied && !policy.loading && (!snapshot || policy.needsReload) && (
          <Button variant="outline" onClick={() => void policy.reload()}>
            {snapshot ? "Reload rules" : "Retry"}
          </Button>
        )}
        {snapshot && draft && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Sign-in:</span>
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
            {!snapshot.enabledProviders.includes("github") && (
              <p className="text-sm text-muted-foreground">GitHub sign-in is not enabled.</p>
            )}
            {snapshot.unsafeAllowAllUsers && (
              <div
                role="status"
                className="rounded-md border border-border p-3 text-sm text-muted-foreground"
              >
                <p>
                  {snapshot.unsafeAllowAllEffective
                    ? "All authenticated users can sign in."
                    : "Unsafe allow-all is set. Current rules still apply."}
                </p>
                <p className="mt-2">
                  Ask your operator to disable unsafe allow-all before you edit rules.
                </p>
              </div>
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
                  {group.help} Limit: {MAX_MANAGED_ADMISSION_RULES} settings rules.
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
                  if (!window.confirm("Discard unsaved changes?")) return;
                  policy.discard();
                  setValue("");
                  setValidationError(null);
                }}
              >
                Cancel
              </Button>
              <span role="status" className="text-xs text-muted-foreground">
                {dirty
                  ? `Unsaved: ${changes.filter(({ action }) => action === "Add").length} added, ${changes.filter(({ action }) => action === "Remove").length} removed.${value ? " Add or clear the value before you save." : ""}`
                  : ""}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              To block a member, use{" "}
              <a href="#workspace-members" className="underline">
                Members &gt; Suspend
              </a>
              .
              {hasPermission("workspace.audit.read") && (
                <>
                  {" "}
                  <a href="/settings?tab=audit-log" className="underline">
                    Audit log
                  </a>
                </>
              )}
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
