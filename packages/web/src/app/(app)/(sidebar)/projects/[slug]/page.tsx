"use client";
import { use } from "react";
import { ProjectPage } from "@/components/projects/project-page";
import { CollapsedSidebarControls } from "@/components/sidebar-layout";
export default function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  return (
    <main className="h-full overflow-y-auto p-6">
      <CollapsedSidebarControls />
      <ProjectPage slug={slug} />
    </main>
  );
}
