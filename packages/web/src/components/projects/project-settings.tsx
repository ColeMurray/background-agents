"use client";
import { useState } from "react";
import { useProjectMutations, type ProjectView } from "@/hooks/use-projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRouter } from "next/navigation";
import { useEnvironments } from "@/hooks/use-environments";
const field = "w-full rounded border border-border bg-background p-2";
export function ProjectSettings({ project }: { project: ProjectView }) {
  const write = useProjectMutations();
  const router = useRouter();
  const { environments } = useEnvironments({ teamId: project.ownerTeamId });
  const [failure, setFailure] = useState("");
  return (
    <section className="space-y-4">
      <form
        key={project.updatedAt}
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const value = (key: string) => String(form.get(key) || "");
          try {
            const result = await write<{ project: ProjectView }>(
              `/api/projects/${project.id}`,
              "PATCH",
              {
                name: value("name"),
                slug: value("slug"),
                brief: value("brief"),
                defaultEnvironmentId: value("environment") || null,
                defaultRepoOwner: value("repoOwner") || null,
                defaultRepoName: value("repoName") || null,
                linearProjectUrl: value("linearUrl") || null,
                linearProjectId: value("linearId") || null,
                primarySlackChannelId: value("channel") || null,
              }
            );
            if (result.project.slug !== project.slug)
              router.replace(`/projects/${result.project.slug}`);
          } catch (cause) {
            setFailure(String(cause));
          }
        }}
      >
        <label className="block">
          Name
          <Input name="name" defaultValue={project.name} required maxLength={100} />
        </label>
        <label className="block">
          URL short name
          <Input name="slug" defaultValue={project.slug} required />
        </label>
        <label className="block">
          Brief
          <textarea
            name="brief"
            defaultValue={project.brief ?? ""}
            rows={9}
            maxLength={20000}
            className={field}
          />
        </label>
        <label className="block">
          Default environment
          <select
            name="environment"
            defaultValue={project.defaultEnvironmentId ?? ""}
            className={field}
          >
            <option value="">None</option>
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm text-muted-foreground">
          Or choose a default repository (leave environment unset).
        </p>
        <Input
          name="repoOwner"
          aria-label="Default repository owner"
          placeholder="Repository owner"
          defaultValue={project.defaultRepoOwner ?? ""}
        />
        <Input
          name="repoName"
          aria-label="Default repository name"
          placeholder="Repository name"
          defaultValue={project.defaultRepoName ?? ""}
        />
        <Input
          name="linearUrl"
          aria-label="Linear project URL"
          placeholder="Linear project URL"
          defaultValue={project.linearProjectUrl ?? ""}
        />
        <Input
          name="linearId"
          aria-label="Linear project identifier"
          placeholder="Linear project ID (optional)"
          defaultValue={project.linearProjectId ?? ""}
        />
        <Input
          name="channel"
          aria-label="Primary Slack channel"
          placeholder="Primary Slack channel ID (optional)"
          defaultValue={project.primarySlackChannelId ?? ""}
        />
        <p className="text-xs text-muted-foreground">
          The primary Slack channel is the fallback for requested agent notifications and completion
          notices. Originating conversations keep their destination; private sessions do not post
          completion notices.
        </p>
        <Button>Save project</Button>
      </form>
      {project.capabilities.canArchive && (
        <div className="flex gap-2">
          {["ship", "archive", "restore"].map((action) => (
            <Button
              key={action}
              variant="outline"
              onClick={async () => {
                try {
                  await write(`/api/projects/${project.id}/${action}`, "POST", {});
                } catch (cause) {
                  setFailure(String(cause));
                }
              }}
            >
              {action}
            </Button>
          ))}
        </div>
      )}
      {failure && <p role="alert">{failure}</p>}
    </section>
  );
}
