"use client";

import { EnablementIntegrationSettings } from "./enablement-integration-settings";

export function VncIntegrationSettings() {
  return (
    <EnablementIntegrationSettings
      copy={{
        id: "vnc",
        title: "VNC Desktop",
        intro:
          "Attach a remote desktop to sandbox sessions. When enabled, each new session gets a VNC desktop accessible through noVNC.",
        overrideDescription: "Override VNC desktop settings for specific repositories.",
        enableLabel: "Enable VNC desktop",
        enableDescription: "Attach a remote desktop to new sandbox sessions",
        scopeDescription: "Enable the VNC desktop globally or for specific repositories.",
        allRepositoriesDescription:
          "The VNC desktop is available for sessions on every accessible repository.",
        selectedRepositoriesDescription:
          "The VNC desktop is only available for repositories in the allowlist.",
        emptySelectionWarning: "No repositories selected. The VNC desktop will not be enabled.",
        emptyOverrides:
          "No repository overrides yet. Add one to enable or disable the VNC desktop per repo.",
        resetDescription:
          "Reset global VNC desktop defaults and repository scope? Per-repository overrides will not be affected.",
      }}
    />
  );
}
