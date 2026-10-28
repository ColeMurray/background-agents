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
  const addsDomain = changes.some(
    ({ action, type }) => action === "Add" && type === "allowedEmailDomains"
  );
  const addsOrganization = changes.some(
    ({ action, type }) => action === "Add" && type === "allowedGitHubOrganizations"
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
          <AlertDialogTitle>Save rule changes?</AlertDialogTitle>
          <AlertDialogDescription>Deployment rules will not change.</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-3 text-sm">
          {changes.map(({ type, value, action }) => (
            <li key={`${type}:${value}`} className="min-w-0 rounded-md border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">
                {action}: {ADMISSION_RULE_GROUPS.find((group) => group.key === type)?.label}
              </p>
              <p className="mt-1 break-all font-mono text-foreground">{value}</p>
              {snapshot.deployment[type].includes(value) && (
                <p className="mt-1 text-muted-foreground">Deployment still allows this entry.</p>
              )}
              {action === "Remove" &&
                type === "allowedEmails" &&
                [...snapshot.deployment.allowedEmailDomains, ...draft.allowedEmailDomains].includes(
                  value.split("@").at(-1) ?? ""
                ) && (
                  <p className="mt-1 text-muted-foreground">
                    A domain rule still allows this email.
                  </p>
                )}
            </li>
          ))}
        </ul>
        {addsDomain && (
          <p className="text-sm text-muted-foreground">
            Domain rules allow all verified emails at that domain.
          </p>
        )}
        {addsOrganization && (
          <p className="text-sm text-muted-foreground">
            Organization rules allow all active members with a verified email.
          </p>
        )}
        {hasRemovals && (
          <p className="text-sm text-muted-foreground">
            Existing sessions stay active. Other rules can still allow access. To block a member,
            use Members &gt; Suspend.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Back</AlertDialogCancel>
          <AlertDialogAction onClick={onSave}>Save changes</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
