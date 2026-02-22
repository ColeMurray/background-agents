"use client";

import Link from "next/link";
import { INTEGRATION_DEFINITIONS } from "@open-inspect/shared";
import { ChevronRightIcon } from "@/components/ui/icons";

export function IntegrationsSettings() {
  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Integrations</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Choose an integration to configure its connection and behavior.
      </p>

      <div className="border border-border-muted rounded-md bg-background">
        <ul className="divide-y divide-border-muted">
          {INTEGRATION_DEFINITIONS.map((integration) => (
            <li key={integration.id}>
              <Link
                href={`/settings/integrations/${integration.id}`}
                className="w-full flex items-start justify-between gap-2 px-4 py-3 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition"
              >
                <div>
                  <p className="text-sm font-medium">{integration.name}</p>
                  <p className="text-xs mt-1">{integration.description}</p>
                </div>
                <ChevronRightIcon className="w-4 h-4 mt-0.5 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
