import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "./providers";
import { APP_ICON_URL, APP_NAME } from "@/lib/site-config";
import "./globals.css";
// Branded themes — each file is self-contained and overrides `:root` tokens
// when its class is active on `<html>`. Imported after `globals.css` so the
// cascade order is correct. Remove a theme by deleting its file, this import
// line, its `APP_THEMES` entry, and its `variables.tf` validation entry.
import "./themes/blue.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Background coding agent for your team",
  ...(APP_ICON_URL ? { icons: { icon: APP_ICON_URL } } : {}),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
