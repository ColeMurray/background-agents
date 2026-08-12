"use client";

import { EnablementIntegrationSettings } from "./enablement-integration-settings";

export function CodeServerIntegrationSettings() {
  return (
    <EnablementIntegrationSettings
      copy={{
        id: "code-server",
        title: "Code Server",
        intro:
          "Attach a browser-based VS Code editor to sandbox sessions. When enabled, each new session gets a code-server instance accessible via a tunnel URL.",
        overrideDescription: "Override code-server settings for specific repositories.",
        enableLabel: "Enable code-server",
        enableDescription: "Attach a VS Code editor to new sandbox sessions",
        scopeDescription: "Enable code-server globally or for specific repositories.",
        allRepositoriesDescription:
          "Code-server is available for sessions on every accessible repository.",
        selectedRepositoriesDescription:
          "Code-server is only available for repositories in the allowlist.",
        emptySelectionWarning: "No repositories selected. Code-server will not be enabled.",
        emptyOverrides:
          "No repository overrides yet. Add one to enable or disable code-server per repo.",
        resetDescription:
          "Reset global code-server defaults and repository scope? Per-repository overrides will not be affected.",
      }}
    />
  );
}
