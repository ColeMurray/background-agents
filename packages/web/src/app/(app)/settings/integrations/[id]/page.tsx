"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { INTEGRATION_DEFINITIONS } from "@open-inspect/shared/types/integrations";
import { BackIcon, XIcon } from "@/components/ui/icons";
import { integrationSettingsComponents } from "@/components/settings/integrations/integration-settings-registry";
import { SettingsNav } from "@/components/settings/settings-nav";
import { useIsMobile } from "@/hooks/use-media-query";

function getIntegration(id: string) {
  return INTEGRATION_DEFINITIONS.find((d) => d.id === id);
}

export default function IntegrationDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const isMobile = useIsMobile();

  const integration = getIntegration(params.id);
  const IntegrationDetail = integration ? integrationSettingsComponents[integration.id] : undefined;
  const content = IntegrationDetail ? (
    <IntegrationDetail />
  ) : (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
      <p>Integration not found.</p>
      <Link href="/settings?tab=integrations" className="text-sm text-accent hover:underline">
        Back to integrations
      </Link>
    </div>
  );

  if (!isMobile) {
    return (
      <div className="flex h-full overflow-hidden bg-background">
        <SettingsNav
          activeCategory="integrations"
          onSelect={(category) => router.push(`/settings?tab=${category}`)}
        />
        <div className="min-w-0 flex-1 overflow-y-auto px-8 py-10 lg:px-12">
          <div className="mx-auto max-w-3xl">
            {integration && (
              <Link
                href="/settings?tab=integrations"
                className="mb-6 flex w-fit items-center gap-2 text-sm text-muted-foreground transition hover:text-foreground"
              >
                <BackIcon className="h-4 w-4" />
                Integrations
              </Link>
            )}
            {content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border-muted px-3 sm:px-4">
        <Link
          href="/settings?tab=integrations"
          className="flex w-fit items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="Back to integrations"
        >
          <BackIcon className="h-4 w-4" />
          <span className="hidden sm:inline">Integrations</span>
        </Link>
        <h1 className="max-w-48 truncate px-2 text-center text-sm font-medium text-foreground sm:max-w-none">
          {integration?.name ?? "Integrations"}
        </h1>
        <Link
          href="/"
          className="ml-auto flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="Close settings"
        >
          <XIcon className="h-4 w-4" />
        </Link>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8 sm:py-10">
        <div className="mx-auto max-w-3xl">{content}</div>
      </div>
    </div>
  );
}
