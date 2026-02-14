import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-jakarta-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        clash: ["var(--font-clash-grotesk)", "ui-serif", "Georgia", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        // ash - gray scale
        ash: {
          100: "#fafafa",
          200: "#f5f5f5",
          300: "#e5e5e5",
          400: "#a3a3a3",
          500: "#737373",
          600: "#525252",
          700: "#404040",
          800: "#262626",
          900: "#171717",
        },
        // clay - warm neutrals
        clay: {
          100: "#f6f6f3",
          200: "#edeee6",
          300: "#c3c2aa",
          400: "#aaa187",
          500: "#918064",
          600: "#685948",
          700: "#483c33",
          800: "#322622",
        },
        // mint - success/green
        mint: {
          100: "#ecfdf5",
          200: "#d1fae5",
          300: "#a7f3d0",
          400: "#10b981",
          500: "#059669",
          600: "#065f46",
          700: "#064e3b",
          800: "#022c22",
        },
        // honey - warning/yellow
        honey: {
          100: "#fef7db",
          200: "#fef3c7",
          300: "#fde68a",
          400: "#fbbf24",
          500: "#f59e0b",
          600: "#d97706",
          700: "#b45309",
          800: "#78350f",
        },
        // lava - error/red
        lava: {
          100: "#fef2f2",
          200: "#fee2e2",
          300: "#fecaca",
          400: "#f87171",
          500: "#ef4444",
          600: "#dc2626",
          700: "#b91c1c",
          800: "#7f1d1d",
        },
        // rebolt - brand orange
        rebolt: {
          100: "#fff7ed",
          200: "#ffe2d4",
          300: "#ffbd9b",
          400: "#ff8547",
          500: "#ff5700",
          600: "#e04b00",
          700: "#b83d00",
          800: "#662200",
        },
        // sky - blue
        sky: {
          50: "#f0f9ff",
          100: "#e0f2fe",
          200: "#bae6fd",
          300: "#7dd3fc",
          400: "#38bdf8",
          500: "#0ea5e9",
          600: "#0284c7",
          700: "#0369a1",
          800: "#075985",
          900: "#0c4a6e",
          950: "#082f49",
        },
      },
    },
  },
  plugins: [typography],
};

export default config;
