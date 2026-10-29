"use client";

import { useId, useRef, useState } from "react";
import { admissionRulesSchema, type AdmissionRules } from "@open-inspect/shared/admission-settings";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { LockIcon } from "@/components/ui/icons";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAdmissionPolicy } from "@/hooks/use-admission-policy";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { SignInAllowlistAddRule } from "./sign-in-allowlist-add-rule";
import { SignInAllowlistReview } from "./sign-in-allowlist-review";
import { SignInAllowlistRow } from "./sign-in-allowlist-row";
import { allowlistEntries, type AllowlistEntry } from "./sign-in-allowlist-rules";
import { useSettingsUnsavedChanges } from "./settings-navigation-guard";

export function SignInAllowlistSection() {
  const policy = useAdmissionPolicy();
  const { hasPermission } = useCurrentUserAuthorization();
  const [input, setInput] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const { snapshot, draft, changes } = policy;
  const pendingInput = input.length > 0;
  const dirty = changes.length > 0 || pendingInput;
  const editable = !!snapshot && !snapshot.editingDisabledReason && !snapshot.unsafeAllowAllUsers;
  const entries = snapshot && draft ? allowlistEntries(snapshot, draft) : [];
  const added = changes.filter(({ action }) => action === "Add").length;
  const removed = changes.length - added;
  const githubRulesWithoutGitHub =
    !!snapshot &&
    !snapshot.enabledProviders.includes("github") &&
    entries.some(
      (entry) => entry.type === "allowedGitHubUsers" || entry.type === "allowedGitHubOrganizations"
    );

  useSettingsUnsavedChanges(dirty);

  function updateDraft(next: AdmissionRules) {
    const parsed = admissionRulesSchema.safeParse(next);
    if (!parsed.success) {
      setValidationError(parsed.error.issues.map((issue) => issue.message).join(" "));
      return false;
    }
    policy.setDraft(parsed.data);
    return true;
  }

  function setEntryInDraft(entry: AllowlistEntry, included: boolean) {
    if (!draft || !policy.canEdit) return;
    const others = draft[entry.type].filter((item) => item !== entry.value);
    updateDraft({ ...draft, [entry.type]: included ? [...others, entry.value] : others });
  }

  return (
    <section ref={panel} tabIndex={-1} aria-labelledby={titleId} className="space-y-3">
      <div>
        <h3 id={titleId} className="text-base font-semibold text-foreground">
          Who can sign in
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Only people who match something on this list can join.
        </p>
      </div>

      {policy.error && <ErrorBanner role="alert">{policy.error}</ErrorBanner>}
      {policy.notice && (
        <p role="status" className="text-sm text-success">
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
        <Button variant="outline" size="sm" onClick={() => void policy.reload()}>
          {snapshot ? "Reload rules" : "Retry"}
        </Button>
      )}
      {snapshot?.unsafeAllowAllUsers && (
        <div
          role="status"
          className="rounded-md border border-warning/30 bg-warning-muted p-3 text-sm text-foreground"
        >
          <p className="font-medium">
            {snapshot.unsafeAllowAllEffective
              ? "All authenticated users can sign in."
              : "Unsafe allow-all is set. Current rules still apply."}
          </p>
          <p className="mt-1 text-muted-foreground">
            Ask your operator to disable unsafe allow-all before you edit rules.
          </p>
        </div>
      )}
      {githubRulesWithoutGitHub && (
        <p role="status" className="text-sm text-warning">
          GitHub sign-in is off, so GitHub rules have no effect.
        </p>
      )}

      {snapshot && draft && (
        <>
          <div className="rounded-md border border-border">
            {editable && (
              <SignInAllowlistAddRule
                value={input}
                error={validationError}
                disabled={!policy.canEdit}
                onValueChange={(next) => {
                  setInput(next);
                  setValidationError(null);
                }}
                onAdd={({ type, value }) => {
                  if (
                    !policy.canEdit ||
                    !updateDraft({ ...draft, [type]: [...draft[type], value] })
                  )
                    return false;
                  setInput("");
                  return true;
                }}
              />
            )}
            <TooltipProvider>
              <ul className="divide-y divide-border-muted">
                {entries.map((entry) => (
                  <SignInAllowlistRow
                    key={`${entry.type}:${entry.value}`}
                    entry={entry}
                    disabled={!policy.canEdit}
                    onRemove={() => setEntryInDraft(entry, false)}
                    onRestore={() => setEntryInDraft(entry, true)}
                  />
                ))}
                {!entries.length && (
                  <li className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {snapshot.unsafeAllowAllEffective
                      ? "No rules. Unsafe allow-all lets every authenticated user sign in."
                      : "No one can sign in yet."}
                  </li>
                )}
              </ul>
            </TooltipProvider>
          </div>

          <p className="text-xs text-muted-foreground">
            {entries.some((entry) => entry.fromDeployment) && (
              <>
                <LockIcon className="inline h-3 w-3 align-[-1px]" aria-hidden /> Set in your
                deployment config.{" "}
              </>
            )}
            To block someone who already joined,{" "}
            <a href="#workspace-members" className="underline hover:text-foreground">
              suspend them in Members
            </a>
            .
            {hasPermission("workspace.audit.read") && (
              <>
                {" "}
                <a href="/settings?tab=audit-log" className="underline hover:text-foreground">
                  Audit log
                </a>
              </>
            )}
          </p>

          {changes.length > 0 && (
            <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-md border border-border bg-popover px-4 py-3 shadow-lg">
              <p role="status" className="min-w-0 flex-1 basis-48 text-sm text-foreground">
                {changes.length} unsaved {changes.length === 1 ? "change" : "changes"}
                <span className="text-muted-foreground">
                  {" "}
                  ·{" "}
                  {[added && `${added} added`, removed && `${removed} removed`]
                    .filter(Boolean)
                    .join(", ")}
                </span>
                {pendingInput && (
                  <span className="block text-xs text-muted-foreground">
                    Add or clear the typed value before you save.
                  </span>
                )}
              </p>
              <div className="ml-auto flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={policy.saving || policy.loading}
                  onClick={() => {
                    if (!window.confirm("Discard unsaved changes?")) return;
                    policy.discard();
                    setInput("");
                    setValidationError(null);
                  }}
                >
                  Discard
                </Button>
                <Button
                  ref={reviewTrigger}
                  size="sm"
                  disabled={!policy.canEdit || pendingInput}
                  onClick={() => setReviewOpen(true)}
                >
                  {policy.saving ? "Saving..." : "Review and save"}
                </Button>
              </div>
            </div>
          )}

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
    </section>
  );
}
