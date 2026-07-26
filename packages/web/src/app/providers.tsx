"use client";

import { ThemeProvider } from "next-themes";
import { SWRConfig } from "swr";
import { WebSessionGate } from "@/components/web-session-gate";
import { Toaster } from "@/components/ui/sonner";
import { SyntaxHighlightTheme } from "@/components/syntax-highlight-theme";
import { AuthSessionProvider } from "@/lib/auth-session";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

async function swrFetcher<T>(url: BrowserApiPath): Promise<T> {
  const res = await browserApiFetch(url);
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
          WebSessionGate owns focus/interval renewal; the one mount-time
          session fetch is safe because WebSessionGate checks only after
          it resolves.
        */}
        <AuthSessionProvider>
          <WebSessionGate>{children}</WebSessionGate>
          <SyntaxHighlightTheme />
          <Toaster />
        </AuthSessionProvider>
      </SWRConfig>
    </ThemeProvider>
  );
}
