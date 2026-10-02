"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { automationNavigation, automationScopeTeamId } from "@/lib/automation-navigation";

/** The automation entry page's team scope from `?teamId=`, and links that preserve it. */
export function useAutomationScope() {
  const teamId = automationScopeTeamId(useSearchParams().get("teamId"));
  const navigation = useMemo(() => automationNavigation(teamId), [teamId]);
  return { teamId, navigation };
}
