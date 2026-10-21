"use client";

import { useCallback } from "react";
import useSWR from "swr";
import { z } from "zod";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { sessionActionErrorMessage } from "@/lib/session-action-error";

/** One unattended publication permission held by an automation. */
export const automationExternalActionGrantSchema = z.object({
  id: z.string().min(1),
  automationId: z.string().min(1),
  executorUserId: z.string().min(1),
  provider: z.string().min(1),
  action: z.string().min(1),
  createdBy: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});

export const automationExternalActionGrantListSchema = z.object({
  grants: z.array(automationExternalActionGrantSchema),
});

export type AutomationExternalActionGrant = z.infer<typeof automationExternalActionGrantSchema>;

export function automationExternalActionGrantsKey(automationId: string): BrowserApiPath {
  return `/api/automations/${automationId}/external-action-grants`;
}

/**
 * The unattended publication grants one automation holds.
 *
 * The control plane owns the grants and the authority to change them. The
 * browser never decides whether a grant may exist.
 */
export function useAutomationExternalActionGrants(automationId: string, enabled: boolean) {
  const query = useSWR<AutomationExternalActionGrant[]>(
    enabled ? automationExternalActionGrantsKey(automationId) : null,
    async (path: BrowserApiPath) => {
      const response = await browserApiFetch(path);
      if (!response.ok) {
        throw new Error(
          await sessionActionErrorMessage(response, "Failed to load external-action grants")
        );
      }
      const parsed = automationExternalActionGrantListSchema.parse(await response.json());
      return parsed.grants;
    },
    { keepPreviousData: true }
  );
  const mutate = query.mutate;
  const create = useCallback(
    async (provider: string, action: string) => {
      const response = await browserApiFetch(automationExternalActionGrantsKey(automationId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, action }),
      });
      if (!response.ok) {
        throw new Error(
          await sessionActionErrorMessage(response, "The grant could not be created")
        );
      }
      await mutate();
    },
    [automationId, mutate]
  );
  const revoke = useCallback(
    async (grantId: string) => {
      const response = await browserApiFetch(
        `/api/automations/${automationId}/external-action-grants/${encodeURIComponent(grantId)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        throw new Error(
          await sessionActionErrorMessage(response, "The grant could not be revoked")
        );
      }
      await mutate();
    },
    [automationId, mutate]
  );
  return {
    grants: query.data ?? [],
    error: query.error instanceof Error ? query.error.message : null,
    isLoading: query.isLoading,
    create,
    revoke,
  };
}
