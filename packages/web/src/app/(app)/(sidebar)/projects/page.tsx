"use client";
import { ProjectsIndex } from "@/components/projects/projects-index";
import { CollapsedSidebarControls } from "@/components/sidebar-layout";
export default function ProjectsPage() {
  return (
    <main className="h-full overflow-y-auto p-6">
      <CollapsedSidebarControls />
      <ProjectsIndex />
    </main>
  );
}
