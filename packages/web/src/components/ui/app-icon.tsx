import { APP_ICON_URL, APP_NAME } from "@/lib/site-config";
import { InspectIcon } from "@/components/ui/icons";

interface AppIconProps {
  className?: string;
}

export function AppIcon({ className }: AppIconProps) {
  if (APP_ICON_URL) {
    return <img src={APP_ICON_URL} alt={`${APP_NAME} logo`} className={className} />;
  }
  return <InspectIcon className={className} />;
}
