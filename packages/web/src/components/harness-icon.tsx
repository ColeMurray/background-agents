import { getHarnessLabel, type HarnessId } from "@open-inspect/shared/harnesses";
import { AnthropicIcon, OpenCodeIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/** Mark of the vendor behind each harness, so the picker reads at a glance. */
const HARNESS_ICONS = {
  opencode: OpenCodeIcon,
  claude: AnthropicIcon,
} as const satisfies Record<HarnessId, unknown>;

export function HarnessIcon({ harness, className }: { harness: HarnessId; className?: string }) {
  const Icon = HARNESS_ICONS[harness];
  return <Icon aria-hidden="true" className={cn("shrink-0", className)} />;
}

/** Icon and name together, laid out the same wherever a harness is shown. */
export function HarnessName({ harness, className }: { harness: HarnessId; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <HarnessIcon harness={harness} className="size-3.5" />
      <span className="truncate">{getHarnessLabel(harness)}</span>
    </span>
  );
}
