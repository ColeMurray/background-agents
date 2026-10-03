"use client";

import Link from "next/link";
import { useAutomationScope } from "@/hooks/use-automation-scope";

export function GitHubAutoReviewDeprecationNotice({ id }: { id: string }) {
  const { navigation } = useAutomationScope();
  return (
    <p id={id} className="mt-2 text-xs text-muted-foreground">
      Replace this deprecated setting with a team-owned automation using the{" "}
      <Link
        href={`${navigation.new("review-new-prs")}&requireTeam=true`}
        className="text-accent hover:underline"
      >
        Review new PRs
      </Link>{" "}
      template. Auto-review continues to create workspace-owned sessions.
    </p>
  );
}
