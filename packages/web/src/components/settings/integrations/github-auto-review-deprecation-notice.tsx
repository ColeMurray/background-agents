import Link from "next/link";
import { automationNavigation } from "@/lib/automation-navigation";

export function GitHubAutoReviewDeprecationNotice({ id }: { id: string }) {
  return (
    <p id={id} className="mt-2 text-xs text-muted-foreground">
      Replace this deprecated setting with a team-owned automation using the{" "}
      <Link
        href={automationNavigation().new("review-new-prs")}
        className="text-accent hover:underline"
      >
        Review new PRs
      </Link>{" "}
      template. Auto-review continues to create workspace-owned sessions.
    </p>
  );
}
