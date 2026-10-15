import type { OpencodePluginReport } from "@open-inspect/shared/types/sandbox-events";
import { CollapsibleSection } from "./collapsible-section";

export function OpencodePluginsSection({
  report,
}: {
  report: OpencodePluginReport | null | undefined;
}) {
  if (!report || report.plugins.length === 0) return null;
  return (
    <CollapsibleSection
      title={`OpenCode plugins (${report.plugins.filter((plugin) => plugin.status === "loaded").length} loaded)`}
      defaultOpen={false}
    >
      <div className="space-y-2">
        {report.plugins.map((plugin) => (
          <div key={plugin.spec} className="space-y-1">
            <p className="break-all font-mono text-xs text-foreground">{plugin.spec}</p>
            <p className="text-xs text-muted-foreground">
              {plugin.status === "pending"
                ? "Loading"
                : plugin.status === "loaded"
                  ? "Loaded"
                  : "Skipped — see session warnings"}
            </p>
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}
