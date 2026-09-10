import { useEffect, useState } from "react";
import useSWR, { type BareFetcher } from "swr";
import { getPrerequisiteStatus } from "@/lib/prerequisite-status";

/** Own the mount refresh so cached data cannot become authoritative before it starts. */
export function usePrerequisiteResource<T>(key: string | null, fetcher?: BareFetcher<T>) {
  const resource = useSWR<T>(key, { ...(fetcher ? { fetcher } : {}), revalidateOnMount: false });
  const { mutate } = resource;
  const [validatedKey, setValidatedKey] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setValidatedKey(null);
    if (key) {
      void mutate()
        .catch(() => undefined)
        .then(() => {
          if (active) setValidatedKey(key);
        });
    }
    return () => {
      active = false;
    };
  }, [key, mutate]);

  return {
    ...resource,
    status: getPrerequisiteStatus(
      key ? resource.data : undefined,
      !!key && (validatedKey !== key || resource.isLoading || resource.isValidating),
      resource.error
    ),
  };
}
