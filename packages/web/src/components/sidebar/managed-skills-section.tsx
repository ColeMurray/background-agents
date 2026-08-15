"use client";

import type { SkillAssignment } from "@open-inspect/shared/types/skills";
import { useSessionSkills } from "@/hooks/use-session-skills";
import { CollapsibleSection } from "./collapsible-section";

function assignmentLabel(assignment: SkillAssignment): string {
  if (assignment.type === "global") return "Global";
  if (assignment.type === "environment") {
    return `Environment: ${assignment.environmentName ?? assignment.environmentId}`;
  }
  return `Repository: ${assignment.repoOwner}/${assignment.repoName}`;
}

export function ManagedSkillsSection({ sessionId }: { sessionId: string }) {
  const { provenance, loading, error, activationReportUnavailable } = useSessionSkills(sessionId);
  if (error) return null;
  if (loading) {
    return (
      <div className="border-b border-border-muted px-4 py-3 text-xs text-muted-foreground">
        Loading managed skills...
      </div>
    );
  }
  if (!provenance) return null;

  const profileLabel =
    provenance.selection?.mode === "profile"
      ? (provenance.selection.profileName ?? "Personal profile")
      : provenance.selection?.mode === "none"
        ? "None"
        : "All applicable";
  const activationStatus = activationReportUnavailable
    ? "report unavailable"
    : (provenance.activation?.status ?? "pending");

  return (
    <CollapsibleSection title={`Managed skills (${provenance.skills.length})`} defaultOpen={false}>
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Selection</span>
          <span className="max-w-[11rem] truncate text-foreground">{profileLabel}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Installation</span>
          <span className="capitalize text-foreground">{activationStatus}</span>
        </div>
        {provenance.activation?.status === "failed" && (
          <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">
            {provenance.activation.message ?? "Managed skills failed to install."}
          </p>
        )}
        {provenance.skills.map((skill) => (
          <div key={skill.skillId} className="rounded border border-border-muted p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-xs font-medium text-foreground">
                {skill.name}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                r{skill.revisionNumber} · {skill.contentSha256.slice(0, 8)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{skill.description}</p>
            {skill.assignmentSources.length > 0 && (
              <p className="mt-2 text-[10px] text-muted-foreground">
                {skill.assignmentSources.map(assignmentLabel).join(" · ")}
              </p>
            )}
          </div>
        ))}
        {provenance.skills.length === 0 && (
          <p className="text-xs text-muted-foreground">No managed skills were pinned.</p>
        )}
      </div>
    </CollapsibleSection>
  );
}
