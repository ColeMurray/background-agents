"use client";
import { inferProjectSourceReference } from "@/lib/project-source-reference";
import { useState } from "react";
import useSWR from "swr";
import { projectRequest, useProjectMutations, type ProjectView } from "@/hooks/use-projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProjectSource } from "@open-inspect/shared/types/projects";
const field = "w-full rounded border border-border bg-background p-2";
export function ProjectSources({ project }: { project: ProjectView }) {
  const { data, error } = useSWR<{ sources: ProjectSource[] }>(
    `/api/projects/${project.id}/sources`,
    projectRequest
  );
  const write = useProjectMutations();
  const [failure, setFailure] = useState("");
  const [editing, setEditing] = useState<ProjectSource>();
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">Context sources</h2>
      {project.linearProjectUrl && (
        <a
          className="block underline"
          href={project.linearProjectUrl}
          target="_blank"
          rel="noreferrer"
        >
          Linear project
        </a>
      )}
      {project.primarySlackChannelId && (
        <p className="text-sm">Primary Slack channel: {project.primarySlackChannelId}</p>
      )}
      <p className="text-sm text-muted-foreground">
        References are links, not synced content. Repository file URLs refer to the current
        checkout, not the linked revision. Page-only sources are never sent to an agent.
      </p>
      {(error || failure) && <p role="alert">{failure || String(error)}</p>}
      {data?.sources.map((source) => (
        <article className="rounded border p-3" key={source.id}>
          <h3>{source.title || source.externalIdOrUrl}</h3>
          <p className="text-sm text-muted-foreground">
            {source.sourceType} · {source.role} · {source.visibility}
          </p>
          {project.capabilities.canManageSources && (
            <Button variant="ghost" onClick={() => setEditing(source)}>
              Edit
            </Button>
          )}
          {project.capabilities.canManageSources && (
            <Button
              variant="ghost"
              onClick={async () => {
                try {
                  await write(`/api/projects/${project.id}/sources/${source.id}`, "DELETE");
                } catch (cause) {
                  setFailure(String(cause));
                }
              }}
            >
              Remove
            </Button>
          )}
        </article>
      ))}
      {project.capabilities.canManageSources && (
        <form
          key={editing?.id ?? "new"}
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const data = new FormData(form);
            let sourceType = String(data.get("type"));
            let ref = String(data.get("ref"));
            if (sourceType === "url") {
              const inferred = inferProjectSourceReference(ref);
              sourceType = inferred.sourceType;
              ref = inferred.externalIdOrUrl;
            }
            try {
              await write(
                `/api/projects/${project.id}/sources${editing ? `/${editing.id}` : ""}`,
                "PUT",
                {
                  sourceType,
                  externalIdOrUrl: ref,
                  title: data.get("title") || null,
                  role: data.get("role"),
                  visibility: data.get("visibility"),
                  refreshPolicy: "never",
                  position: data?.get("position") ? Number(data.get("position")) : 0,
                }
              );
              form.reset();
              setEditing(undefined);
            } catch (cause) {
              setFailure(String(cause));
            }
          }}
        >
          <Input
            name="title"
            defaultValue={editing?.title ?? ""}
            aria-label="Source title"
            placeholder="Title (optional)"
          />
          <Input
            name="ref"
            defaultValue={editing?.externalIdOrUrl ?? ""}
            aria-label="Source reference"
            placeholder="URL, channel, owner/repository:path, or session ID"
            required
          />
          <select
            name="type"
            defaultValue={editing?.sourceType ?? "url"}
            aria-label="Source type"
            className={field}
          >
            {["url", "repo_doc", "session", "slack_channel", "linear_project"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select
            name="role"
            aria-label="Source role"
            defaultValue={editing?.role ?? "reference"}
            className={field}
          >
            {["brief", "decisions", "tickets", "channel", "metrics", "reference"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select
            name="visibility"
            defaultValue={editing?.visibility ?? "agent"}
            aria-label="Source visibility"
            className={field}
          >
            <option value="agent">Visible to agents</option>
            <option value="page_only">Page only</option>
          </select>
          <Input
            name="position"
            aria-label="Source order"
            type="number"
            min={0}
            max={10000}
            defaultValue={editing?.position ?? 0}
          />
          <Button>{editing ? "Save source" : "Add source"}</Button>
          {editing && (
            <Button type="button" variant="ghost" onClick={() => setEditing(undefined)}>
              Cancel
            </Button>
          )}
        </form>
      )}
    </section>
  );
}
