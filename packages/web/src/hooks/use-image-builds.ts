"use client";

import useSWR from "swr";
import { IMAGE_BUILDS_KEY, imageBuildPollInterval, type ImageBuildsFeed } from "@/lib/image-builds";
import { supportsRepoImages } from "@/lib/sandbox-provider";

/**
 * The unified image-build feed with its canonical refresh policy. All
 * consumers of `IMAGE_BUILDS_KEY` read it through here — SWR options are
 * hook-local, so a consumer fetching the key directly would silently opt out
 * of the polling and error contract.
 *
 * `enabled` gates the fetch on top of provider support, for consumers that
 * have nothing to annotate yet.
 */
export function useImageBuilds(enabled = true) {
  const { data, error, isLoading } = useSWR<ImageBuildsFeed>(
    supportsRepoImages() && enabled ? IMAGE_BUILDS_KEY : null,
    { refreshInterval: (latest) => imageBuildPollInterval(latest?.images) }
  );
  return { data, error, isLoading };
}
