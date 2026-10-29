import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import {
  BuildingIcon,
  GitHubIcon,
  GlobeIcon,
  LockIcon,
  MailIcon,
  XIcon,
} from "@/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ADMISSION_RULE_GROUPS } from "./admission-rule-groups";
import {
  describeRule,
  type AdmissionRuleType,
  type AllowlistEntry,
} from "./sign-in-allowlist-rules";

export const RULE_ICONS: Record<AdmissionRuleType, ComponentType<{ className?: string }>> = {
  allowedEmails: MailIcon,
  allowedEmailDomains: GlobeIcon,
  allowedGitHubUsers: GitHubIcon,
  allowedGitHubOrganizations: BuildingIcon,
};

/** One rule as a single line: type icon, plain-language text, and its one available action. */
export function SignInAllowlistRow({
  entry,
  disabled,
  onRemove,
  onRestore,
}: {
  entry: AllowlistEntry;
  disabled: boolean;
  onRemove: () => void;
  onRestore: () => void;
}) {
  const Icon = RULE_ICONS[entry.type];
  const text = describeRule(entry.type, entry.value);
  const group = ADMISSION_RULE_GROUPS.find((candidate) => candidate.key === entry.type)!;
  // Removing the settings copy of a deployment rule doesn't revoke access, so don't strike it.
  const revoked = entry.status === "removed" && !entry.fromDeployment;

  return (
    <li className="flex min-h-11 items-center gap-3 px-4 py-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span
        className={cn(
          "min-w-0 flex-1 break-words text-sm",
          revoked ? "text-muted-foreground line-through" : "text-foreground"
        )}
      >
        {text}
      </span>
      {entry.status === "added" && (
        <span className="rounded-sm bg-accent-muted px-1.5 py-0.5 text-xs text-accent">New</span>
      )}
      {entry.fromDeployment && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              tabIndex={0}
              aria-label={`Set by deployment: ${group.environment} / ${group.terraform}`}
              className="flex h-[26px] w-[26px] items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <LockIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Set in your deployment config ({group.environment} / {group.terraform}). It can&apos;t
            be changed here.
          </TooltipContent>
        </Tooltip>
      )}
      {entry.status === "removed" ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled}
          aria-label={`Undo removing ${text}`}
          onClick={onRestore}
        >
          Undo
        </Button>
      ) : (
        entry.inDraft && (
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label={entry.fromDeployment ? `Remove settings copy of ${text}` : `Remove ${text}`}
            title={
              entry.fromDeployment
                ? "Remove the settings copy. The deployment rule still applies."
                : undefined
            }
            onClick={onRemove}
          >
            <XIcon className="h-3.5 w-3.5" />
          </Button>
        )
      )}
    </li>
  );
}
