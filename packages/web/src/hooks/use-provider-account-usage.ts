import useSWRMutation from "swr/mutation";
import { providerAccountUsageResponseSchema } from "@open-inspect/shared/types/provider-account-usage";
import { useCurrentUserAuthorization } from "./use-current-user-authorization";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

export function useProviderAccountUsage(accountId: string) {
  const { hasPermission } = useCurrentUserAuthorization();
  return useSWRMutation(
    `/api/model-provider-accounts/${accountId}/usage` as BrowserApiPath,
    async (path) => {
      if (!hasPermission("provider_accounts.read")) throw new Error("Usage check not authorized");
      const response = await browserApiFetch(path);
      if (!response.ok) throw new Error("Usage could not be loaded");
      return providerAccountUsageResponseSchema.parse(await response.json()).usage;
    },
    {
      // Every explicit action reaches the server, which owns observation freshness.
      throwOnError: false,
    }
  );
}
