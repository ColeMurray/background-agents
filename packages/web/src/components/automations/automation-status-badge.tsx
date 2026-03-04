import type { Automation } from "@open-inspect/shared";
import { Badge } from "@/components/ui/badge";

export function AutomationStatusBadge({ automation }: { automation: Automation }) {
  if (automation.enabled && automation.consecutiveFailures > 0) {
    return (
      <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
        Degraded ({automation.consecutiveFailures} failures)
      </Badge>
    );
  }
  if (automation.enabled) {
    return <Badge className="bg-success-muted text-success">Enabled</Badge>;
  }
  return <Badge className="bg-muted text-muted-foreground">Paused</Badge>;
}
