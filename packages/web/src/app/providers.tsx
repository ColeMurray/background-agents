"use client";

import { SessionProvider } from "next-auth/react";
import { SWRConfig } from "swr";
import { ThemeProvider } from "@/components/theme-provider";
import type { ThemeId } from "@/lib/theme";

async function swrFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

export function Providers({
  children,
  initialTheme,
}: {
  children: React.ReactNode;
  initialTheme: ThemeId;
}) {
  return (
    <SWRConfig value={{ fetcher: swrFetcher, revalidateOnFocus: true, dedupingInterval: 2000 }}>
      <SessionProvider>
        <ThemeProvider initialTheme={initialTheme}>{children}</ThemeProvider>
      </SessionProvider>
    </SWRConfig>
  );
}
