"use client";

import { use } from "react";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { TeamPage } from "@/components/teams/team-page";

export default function TeamDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { isOpen } = useSidebarContext();
  return (
    <div className="flex h-full flex-col">
      {!isOpen && (
        <header className="shrink-0 border-b border-border-muted">
          <div className="px-4 py-3">
            <CollapsedSidebarControls />
          </div>
        </header>
      )}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-3xl">
          <TeamPage slug={slug} />
        </div>
      </div>
    </div>
  );
}
