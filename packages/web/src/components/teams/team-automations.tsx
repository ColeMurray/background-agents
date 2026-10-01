"use client";

import Link from "next/link";
import { AutomationCollection } from "@/components/automations/automation-collection";
import { Button } from "@/components/ui/button";
import { automationNavigation } from "@/lib/automation-navigation";

export function TeamAutomations({ teamId }: { teamId: string }) {
  return (
    <div>
      <AutomationCollection teamId={teamId}>
        {(canCreate) => (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-foreground">Automations</h2>
            {canCreate && (
              <Button size="xs" asChild>
                <Link href={automationNavigation(teamId).new()}>Create Automation</Link>
              </Button>
            )}
          </div>
        )}
      </AutomationCollection>
    </div>
  );
}
