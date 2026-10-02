"use client";
import { useState } from "react";
import Link from "next/link";
import { useProject } from "@/hooks/use-projects";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { Button } from "@/components/ui/button";
import { ProjectOverview } from "./project-overview";
import { ProjectSessions, ProjectPullRequests } from "./project-work";
import { ProjectSources } from "./project-sources";
import { ProjectSettings } from "./project-settings";
import { ProjectAutomations } from "./project-automations";
export function ProjectPage({ slug }: { slug: string }) {
  const { project, loading, error } = useProject(slug);
  const [tab, setTab] = useState("Overview");
  const { hasPermission } = useCurrentUserAuthorization();
  if (loading) return <p>Loading project…</p>;
  if (error || !project) return <p role="alert">Project unavailable.</p>;
  const activeTab = tab === "Settings" && !project.capabilities.canEditMetadata ? "Overview" : tab;
  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap justify-between gap-4">
        <div>
          <Link href="/projects" className="text-sm text-muted-foreground">
            Projects
          </Link>
          <h1 className="text-3xl font-semibold">{project.name}</h1>
          <p className="text-muted-foreground">{project.status}</p>
        </div>
        {hasPermission("sessions.create") && (
          <Link
            href={`/?projectId=${encodeURIComponent(project.id)}`}
            className="self-center rounded bg-accent px-4 py-2 text-accent-foreground"
          >
            Start session
          </Link>
        )}
      </header>
      <nav aria-label="Project tabs" className="flex flex-wrap gap-2 border-b pb-3">
        {[
          "Overview",
          "Sessions",
          "Pull requests",
          "Sources",
          "Automations",
          ...(project.capabilities.canEditMetadata ? ["Settings"] : []),
        ].map((name) => (
          <Button
            key={name}
            variant={activeTab === name ? "subtle" : "ghost"}
            aria-current={activeTab === name ? "page" : undefined}
            onClick={() => setTab(name)}
          >
            {name}
          </Button>
        ))}
      </nav>
      {activeTab === "Overview" && <ProjectOverview project={project} />}
      {activeTab === "Sessions" && <ProjectSessions project={project} />}
      {activeTab === "Pull requests" && <ProjectPullRequests id={project.id} />}
      {activeTab === "Sources" && <ProjectSources project={project} />}
      {activeTab === "Settings" && <ProjectSettings project={project} />}
      {activeTab === "Automations" && <ProjectAutomations project={project} />}
    </section>
  );
}
