import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { getServerSession } from "next-auth";
import { Providers } from "./providers";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { DEFAULT_THEME_ID, getThemeClass, isThemeId, type ThemeId } from "@/lib/theme";
import "./globals.css";

const inter = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Danstack Background Agents",
  description: "Danstack background agent manager",
};

async function getInitialTheme(): Promise<ThemeId> {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return DEFAULT_THEME_ID;

    const userId = session.user.id || session.user.email;
    if (!userId) return DEFAULT_THEME_ID;

    const response = await controlPlaneFetch(`/user-preferences/${encodeURIComponent(userId)}`);
    if (!response.ok) return DEFAULT_THEME_ID;

    const data = (await response.json()) as { theme?: string };
    return data.theme && isThemeId(data.theme) ? data.theme : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const initialTheme = await getInitialTheme();

  return (
    <html lang="en" className={`dark ${getThemeClass(initialTheme)}`}>
      <body className={`${inter.variable} ${jetBrainsMono.variable}`}>
        <Providers initialTheme={initialTheme}>{children}</Providers>
      </body>
    </html>
  );
}
