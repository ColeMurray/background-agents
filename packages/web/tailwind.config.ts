import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Core semantic colors - all use CSS variables that switch with dark mode
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: "var(--card)",
        "card-foreground": "var(--card-foreground)",
        primary: "var(--primary)",
        "primary-foreground": "var(--primary-foreground)",
        accent: "var(--accent)",
        "accent-foreground": "var(--accent-foreground)",
        "accent-muted": "var(--accent-muted)",
        muted: "var(--muted)",
        "muted-foreground": "var(--muted-foreground)",
        "secondary-foreground": "var(--secondary-foreground)",
        border: "var(--border)",
        "border-muted": "var(--border-muted)",
        input: "var(--input)",
        ring: "var(--ring)",
        success: "var(--success)",
        "success-foreground": "var(--success-foreground)",
        "success-muted": "var(--success-muted)",
        warning: "var(--warning)",
        "warning-foreground": "var(--warning-foreground)",
        "warning-muted": "var(--warning-muted)",
        destructive: "var(--destructive)",
        "destructive-foreground": "var(--destructive-foreground)",
        "destructive-muted": "var(--destructive-muted)",
        info: "var(--info)",
        "info-foreground": "var(--info-foreground)",
        "info-muted": "var(--info-muted)",
      },
    },
  },
  plugins: [typography],
};

export default config;
