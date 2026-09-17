"use client";

import type { Skill, SkillAssignment } from "@open-inspect/shared/types/skills";
import { Button } from "@/components/ui/button";

function assignmentLabel(assignment: SkillAssignment): string {
  if (assignment.type === "global") return "All sessions";
  if (assignment.type === "repository") {
    return `Repository: ${assignment.repoOwner}/${assignment.repoName}`;
  }
  return `Environment: ${assignment.environmentName ?? assignment.environmentId}`;
}

/** Read-only detail surface for users who may inspect, but not manage, shared skills. */
export function SkillDetails({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const supplementalFiles = skill.files.filter(({ path }) => path !== "SKILL.md");
  const metadataEntries = Object.entries(skill.metadata);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-mono text-base font-semibold text-foreground">{skill.name}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{skill.description}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <section>
        <h4 className="text-sm font-medium text-foreground">Instructions</h4>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-4 text-xs">
          {skill.body}
        </pre>
      </section>

      <section className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <h4 className="font-medium text-foreground">License</h4>
          <p className="mt-1 text-muted-foreground">{skill.license ?? "Not specified"}</p>
        </div>
        <div>
          <h4 className="font-medium text-foreground">Compatibility</h4>
          <p className="mt-1 text-muted-foreground">{skill.compatibility ?? "Not specified"}</p>
        </div>
      </section>

      <section>
        <h4 className="text-sm font-medium text-foreground">Assignments</h4>
        {skill.assignments.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {skill.assignments.map((assignment) => (
              <li key={assignment.id}>{assignmentLabel(assignment)}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">No assignments</p>
        )}
      </section>

      <section>
        <h4 className="text-sm font-medium text-foreground">Files</h4>
        {supplementalFiles.length > 0 ? (
          <div className="mt-2 space-y-3">
            {supplementalFiles.map((file) => (
              <div key={file.path} className="rounded border border-border-muted p-3">
                <p className="font-mono text-xs text-foreground">
                  {file.path}
                  {file.executable ? " (executable)" : ""}
                </p>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                  {file.content}
                </pre>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">No supplemental files</p>
        )}
      </section>

      {metadataEntries.length > 0 && (
        <section>
          <h4 className="text-sm font-medium text-foreground">Metadata</h4>
          <dl className="mt-2 grid gap-2 text-sm">
            {metadataEntries.map(([key, value]) => (
              <div key={key} className="grid grid-cols-[10rem_1fr] gap-3">
                <dt className="font-mono text-muted-foreground">{key}</dt>
                <dd className="text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {skill.source && (
        <section>
          <h4 className="text-sm font-medium text-foreground">Import source</h4>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {skill.source.repoOwner}/{skill.source.repoName} at {skill.source.commitSha}
            {skill.source.subdirectory ? ` / ${skill.source.subdirectory}` : ""}
          </p>
        </section>
      )}

      <p className="rounded border border-border-muted p-3 text-xs text-muted-foreground">
        Revision {skill.revisionNumber} by{" "}
        {skill.revisionAuthorDisplayName ?? skill.revisionCreatedBy}
        {" · "}SHA-256 {skill.revisionSha256}
      </p>
    </div>
  );
}
