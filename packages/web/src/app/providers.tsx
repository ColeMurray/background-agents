"use client";

import { SWRConfig } from "swr";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";

async function swrFetcher<T>(url: string): Promise<T> {
  // Rewrite /api/* paths to point at the local server
  const fetchUrl = url.startsWith("/api/") ? `${API_BASE}${url.replace("/api", "")}` : url;
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ fetcher: swrFetcher, revalidateOnFocus: true, dedupingInterval: 2000 }}>
      {children}
    </SWRConfig>
  );
}

export { API_BASE };
