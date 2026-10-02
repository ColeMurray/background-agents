"use client";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProjects, useProjectMutations } from "@/hooks/use-projects";
import { useMeTeams } from "@/hooks/use-teams";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ProjectsIndex({ teamId }: { teamId?: string }) {
  const { hasPermission } = useCurrentUserAuthorization();
  const [status, setStatus] = useState("active");
  const [search, setSearch] = useState("");
  const [mine, setMine] = useState(false);
  const { projects, loading, error } = useProjects({ status, search, mine, teamId });
  const { teams, requireTeamOnCreate, loading: teamsLoading } = useMeTeams();
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState("");
  const write = useProjectMutations();
  const router = useRouter();
  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">Projects</h1>
        <p className="mt-2 text-muted-foreground">
          Keep the brief, decisions and work for an outcome together.
        </p>
      </header>
      <div className="flex flex-wrap gap-3">
        <Input
          aria-label="Search projects"
          placeholder="Search projects"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Project status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded border bg-background p-2"
        >
          {["active", "shipped", "archived"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Mine
        </label>
        {hasPermission("projects.create") && (
          <Button onClick={() => setCreating(!creating)}>New project</Button>
        )}
      </div>
      {creating && (
        <form
          className="space-y-3 rounded-lg border p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setFailure("");
            const form = new FormData(e.currentTarget);
            try {
              const result = await write<{ project: { slug: string } }>("/api/projects", "POST", {
                name: form.get("name"),
                slug: form.get("slug"),
                ownerTeamId: form.get("team") || null,
              });
              router.push(`/projects/${result.project.slug}`);
            } catch (cause) {
              setFailure(String(cause));
            }
          }}
        >
          <label className="block">
            Name
            <Input name="name" required maxLength={100} />
          </label>
          <label className="block">
            Short name for the URL
            <Input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={100} />
          </label>
          <label className="block">
            Owning team
            <select
              name="team"
              defaultValue={teamId ?? (requireTeamOnCreate ? (teams[0]?.id ?? "") : "")}
              required={requireTeamOnCreate}
              className="ml-3 rounded border bg-background p-2"
            >
              {requireTeamOnCreate ? (
                <option value="" disabled>
                  Select a team
                </option>
              ) : (
                <option value="">Workspace</option>
              )}
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={teamsLoading || (requireTeamOnCreate && !teams.length)}>
            Create project
          </Button>
        </form>
      )}
      {(failure || error) && (
        <p role="alert" className="text-red-500">
          {failure || String(error)}
        </p>
      )}
      {loading ? (
        <p>Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="text-muted-foreground">No projects in this view.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.slug}`}
              className="rounded-lg border border-border p-5 hover:bg-muted/30"
            >
              <div className="flex justify-between">
                <h2 className="font-semibold">{project.name}</h2>
                <span className="text-sm text-muted-foreground">{project.status}</span>
              </div>
              <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                {project.statusSummary ||
                  project.brief ||
                  "Add a brief to give the next session a starting point."}
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                {project.openPrCount ?? 0} open PRs · Active{" "}
                {new Date(project.lastActivityAt ?? project.updatedAt).toLocaleDateString()}
              </p>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
