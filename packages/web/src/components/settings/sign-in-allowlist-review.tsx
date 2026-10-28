import type {
  AdmissionPolicySnapshot,
  AdmissionRules,
} from "@open-inspect/shared/admission-settings";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { admissionRuleChanges } from "@/hooks/use-admission-policy";
import { ADMISSION_RULE_GROUPS } from "./admission-rule-groups";

export function SignInAllowlistReview({
  open,
  onOpenChange,
  snapshot,
  draft,
  onSave,
  onCloseFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: AdmissionPolicySnapshot;
  draft: AdmissionRules;
  onSave: () => void;
  onCloseFocus: () => void;
}) {
  const changes = admissionRuleChanges(snapshot.managed, draft);
  const hasRemovals = changes.some(({ action }) => action === "Remove");
  const broadAddition = changes.some(
    ({ action, type }) =>
      action === "Add" && (type === "allowedEmailDomains" || type === "allowedGitHubOrganizations")
  );

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="max-h-[85dvh] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseFocus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Review sign-in allowlist changes</AlertDialogTitle>
          <AlertDialogDescription>
            Any matching rule allows sign-in (OR). Rules are alternatives, not cumulative
            requirements. Deployment rules cannot be changed here.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-3 text-sm">
          {changes.map(({ type, value, action }) => (
            <li key={`${type}:${value}`} className="min-w-0 rounded-md border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">
                {action} settings rule:{" "}
                {ADMISSION_RULE_GROUPS.find((group) => group.key === type)?.label}
              </p>
              <p className="mt-1 break-all font-mono text-foreground">{value}</p>
              {snapshot.deployment[type].includes(value) && (
                <p className="mt-1 text-muted-foreground">
                  {action === "Remove"
                    ? "This entry will still allow sign-in through deployment configuration."
                    : "Deployment already allows this entry; the settings copy grants no additional access."}
                </p>
              )}
              {action === "Remove" &&
                type === "allowedEmails" &&
                [...snapshot.deployment.allowedEmailDomains, ...draft.allowedEmailDomains].includes(
                  value.split("@").at(-1) ?? ""
                ) && (
                  <p className="mt-1 text-muted-foreground">
                    An allowed email domain still covers this address.
                  </p>
                )}
            </li>
          ))}
        </ul>
        {broadAddition && (
          <p className="text-sm text-muted-foreground">
            Adding a domain admits all matching verified email identities; adding an organization
            admits all active members with verified GitHub email evidence, not just existing
            workspace members.
          </p>
        )}
        {hasRemovals && (
          <p className="text-sm text-muted-foreground">
            Removals may affect future sign-in and other operations that recheck sign-in
            eligibility. They do not suspend members or revoke existing sessions. Other rules may
            still allow access; this is not a complete impact analysis. Use Members &gt; Suspend to
            revoke a member&apos;s access. An operator can restore eligibility by adding a known
            valid email in deployment configuration.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          No invitation is sent. No member is created and no role is assigned by this change.
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>Back to editing</AlertDialogCancel>
          <AlertDialogAction onClick={onSave}>Confirm and save</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
