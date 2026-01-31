import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  darkMode: "media",
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
        "success-muted": "var(--success-muted)",
      },
    },
  },
  plugins: [typography],
};

export default config;
