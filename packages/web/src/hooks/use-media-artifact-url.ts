"use client";

import { useEffect } from "react";
import useSWR from "swr";

interface MediaArtifactUrlResponse {
  url: string;
  expiresAt: number;
}

const MEDIA_URL_REFRESH_BUFFER_MS = 60_000;

async function fetcher(url: string): Promise<MediaArtifactUrlResponse> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load media URL: ${response.status}`);
  }

  return response.json();
}

export function useMediaArtifactUrl(sessionId: string, artifactId: string | null) {
  const key = artifactId ? `/api/sessions/${sessionId}/media/${artifactId}` : null;
  const { data, error, isLoading, mutate } = useSWR(key, fetcher, {
    revalidateOnFocus: true,
  });

  useEffect(() => {
    if (!key || !data?.expiresAt) {
      return;
    }

    const refreshAtMs = data.expiresAt * 1000 - MEDIA_URL_REFRESH_BUFFER_MS;
    const delayMs = refreshAtMs - Date.now();
    if (delayMs <= 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void mutate();
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [data?.expiresAt, key, mutate]);

  return {
    url: data?.url ?? null,
    expiresAt: data?.expiresAt ?? null,
    isLoading,
    error,
    refresh: mutate,
  };
}
