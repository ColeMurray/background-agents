"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { INTEGRATION_DEFINITIONS, type IntegrationId } from "@open-inspect/shared";
import { useSidebarContext } from "@/components/sidebar-layout";
import { SidebarIcon, BackIcon } from "@/components/ui/icons";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { useIsMobile } from "@/hooks/use-media-query";
import { GitHubIntegrationSettings } from "@/components/settings/integrations/github-integration-settings";
import { LinearIntegrationSettings } from "@/components/settings/integrations/linear-integration-settings";

function getIntegration(id: string) {
  return INTEGRATION_DEFINITIONS.find((d) => d.id === id);
}

function IntegrationDetail({ integrationId }: { integrationId: IntegrationId }) {
  if (integrationId === "github") return <GitHubIntegrationSettings />;
  if (integrationId === "linear") return <LinearIntegrationSettings />;
  return null;
}

export default function IntegrationDetailPage() {
  const params = useParams<{ id: string }>();
  const { isOpen, toggle } = useSidebarContext();
  const isMobile = useIsMobile();

  const integration = getIntegration(params.id);

  if (!integration) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        Integration not found.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <header className="border-b border-border-muted flex-shrink-0">
        <div className="px-4 py-3 flex items-center gap-2">
          {(!isOpen || isMobile) && (
            <button
              onClick={toggle}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
              title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
              aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
            >
              <SidebarIcon className="w-4 h-4" />
            </button>
          )}
          <Link
            href="/settings?tab=integrations"
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
            aria-label="Back to integrations"
          >
            <BackIcon className="w-4 h-4" />
          </Link>
          <h2 className="text-sm font-medium text-foreground">{integration.name}</h2>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="max-w-2xl">
          <IntegrationDetail integrationId={integration.id} />
        </div>
      </div>
    </div>
  );
}
