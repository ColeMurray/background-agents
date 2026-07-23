"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { SWRConfig } from "swr";
import { OiSessionRefresh } from "@/components/oi-session-refresh";
import { Toaster } from "@/components/ui/sonner";
import { SyntaxHighlightTheme } from "@/components/syntax-highlight-theme";

async function swrFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <SWRConfig value={{ fetcher: swrFetcher, revalidateOnFocus: true, dedupingInterval: 2000 }}>
        {/*
          refetchOnWindowFocus must stay off: /api/auth/session re-writes the
          session cookie from the claims it decoded, so a focus refetch races
          the oi-refresh rotation write and can re-persist an already-consumed
          refresh token (family revocation once outside the reuse grace).
          OiSessionRefresh owns focus/interval renewal; the one mount-time
          session fetch is safe because OiSessionRefresh pings only after it
          resolves.
        */}
        <SessionProvider refetchOnWindowFocus={false}>
          {children}
          <OiSessionRefresh />
          <SyntaxHighlightTheme />
          <Toaster />
        </SessionProvider>
      </SWRConfig>
    </ThemeProvider>
  );
}
