"use client";

import { SessionProvider } from "next-auth/react";
import { SWRConfig } from "swr";

async function swrFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ fetcher: swrFetcher, revalidateOnFocus: true, dedupingInterval: 2000 }}>
      <SessionProvider>{children}</SessionProvider>
    </SWRConfig>
  );
}
