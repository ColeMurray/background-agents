import useSWR from "swr";
import { useEffect, useState } from "react";
import type { ResolvedSkill } from "@open-inspect/shared/types/skills";

const ACTIVATION_REPORT_TIMEOUT_MS = 10 * 60 * 1000;
const ACTIVATION_POLL_INTERVAL_MS = 2_000;

export interface SessionSkillsProvenance {
  manifestSha256?: string;
  resolverVersion?: number;
  resolvedAt?: number;
  selection?:
    | { mode: "all" }
    | { mode: "none" }
    | { mode: "profile"; profileId: string; profileName?: string };
  skills: ResolvedSkill[];
  activation?: {
    status: "pending" | "activated" | "failed";
    activatedAt: number | null;
    errorCode: string | null;
    message: string | null;
  } | null;
}

export function useSessionSkills(sessionId: string) {
  const [activationReportUnavailable, setActivationReportUnavailable] = useState(false);
  useEffect(() => {
    setActivationReportUnavailable(false);
    const timer = window.setTimeout(
      () => setActivationReportUnavailable(true),
      ACTIVATION_REPORT_TIMEOUT_MS
    );
    return () => window.clearTimeout(timer);
  }, [sessionId]);
  const { data, isLoading, error } = useSWR<SessionSkillsProvenance>(
    `/api/sessions/${sessionId}/skills`,
    {
      refreshInterval: (latest) =>
        latest?.activation?.status === "pending" && !activationReportUnavailable
          ? ACTIVATION_POLL_INTERVAL_MS
          : 0,
    }
  );
  return {
    provenance: data,
    loading: isLoading,
    error,
    activationReportUnavailable:
      activationReportUnavailable && data?.activation?.status === "pending",
  };
}
