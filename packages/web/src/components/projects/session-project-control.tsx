"use client";
import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  useProjects,
  useProjectMutations,
  projectRequest,
  type ProjectView,
} from "@/hooks/use-projects";
import { Button } from "@/components/ui/button";

export function SessionProjectControl({
  sessionId,
  canAssociate,
}: {
  sessionId: string;
  canAssociate: boolean;
}) {
  const { projects } = useProjects();
  const { data, mutate } = useSWR<{
    project: ProjectView | null;
    snapshot: { text: string; bytes: number } | null;
  }>(`/api/sessions/${sessionId}/project-snapshot`, projectRequest);
  const write = useProjectMutations();
  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState("");
  return (
    <section className="space-y-2 border-b border-border-muted p-4">
      <h3 className="text-xs font-medium uppercase text-muted-foreground">Project</h3>
      {data?.project ? (
        <Link className="text-sm underline" href={`/projects/${data.project.slug}`}>
          {data.project.name}
        </Link>
      ) : (
        <p className="text-sm text-muted-foreground">No visible project</p>
      )}
      {canAssociate && (
        <Button variant="ghost" onClick={() => setEditing(!editing)}>
          {data?.project ? "Move or remove" : "Add to project"}
        </Button>
      )}
      {editing && (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            try {
              await write(`/api/sessions/${sessionId}/project`, "PUT", {
                projectId: form.get("project") || null,
                includeChildren: form.get("children") === "on",
              });
              await mutate();
              setEditing(false);
            } catch (cause) {
              setFailure(String(cause));
            }
          }}
        >
          <select
            name="project"
            aria-label="Move to project"
            defaultValue={data?.project?.id ?? ""}
            className="w-full rounded border bg-background p-2"
          >
            <option value="">No project</option>
            {projects
              .filter((project) => project.capabilities.canAssociateSessions)
              .map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
          </select>
          <label className="block text-sm">
            <input type="checkbox" name="children" defaultChecked /> Include child sessions
          </label>
          <Button>Save association</Button>
        </form>
      )}
      {failure && <p role="alert">{failure}</p>}
      {data?.project && !data.snapshot && (
        <p className="text-xs text-muted-foreground">
          Project context is available when the runtime next starts. Associating work does not
          rewrite its original context.
        </p>
      )}
      {data?.snapshot && (
        <details className="text-sm">
          <summary>Creation context ({(data.snapshot.bytes / 1000).toFixed(1)} KB)</summary>
          <p className="my-2 text-xs text-muted-foreground">
            This snapshot stays unchanged when the project is edited or this session moves.
          </p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">
            {data.snapshot.text}
          </pre>
        </details>
      )}
    </section>
  );
}
