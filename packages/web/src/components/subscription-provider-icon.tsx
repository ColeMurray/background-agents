import type { SubscriptionProviderId } from "@open-inspect/shared/types/provider-accounts";
import { GrokIcon, OpenAIIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

const SUBSCRIPTION_PROVIDER_ICONS = {
  openai: OpenAIIcon,
  xai: GrokIcon,
} as const;

export function SubscriptionProviderIcon({
  provider,
  className,
}: {
  provider: SubscriptionProviderId;
  className?: string;
}) {
  const Icon = SUBSCRIPTION_PROVIDER_ICONS[provider];
  return <Icon aria-hidden="true" className={cn("shrink-0", className)} />;
}
