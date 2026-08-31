"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { INTEGRATION_DEFINITIONS } from "@open-inspect/shared/types/integrations";
import { BackIcon } from "@/components/ui/icons";
import { integrationSettingsComponents } from "@/components/settings/integrations/integration-settings-registry";
import { SettingsMobileHeader } from "@/components/settings/settings-mobile-header";
import { useSettingsIsMobile } from "@/components/settings/settings-viewport-context";

function getIntegration(id: string) {
  return INTEGRATION_DEFINITIONS.find((d) => d.id === id);
}

export default function IntegrationDetailPage() {
  const params = useParams<{ id: string }>();
  const isMobile = useSettingsIsMobile();

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
      <>
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
      </>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <SettingsMobileHeader
        title={integration?.name ?? "Integrations"}
        backHref="/settings?tab=integrations"
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8 sm:py-10">
        <div className="mx-auto max-w-3xl">{content}</div>
      </div>
    </div>
  );
}
