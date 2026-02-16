import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { resolve } from "path";
import manifest from "./manifest.json";

export default defineConfig(({ mode }) => {
  // load all env vars (not just VITE_*) so we can remap the vercel ones
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [
      react(),
      crx({ manifest }),
    ],
    define: {
      // remap vercel env vars to VITE_* so the extension can use them
      // via import.meta.env without exposing secrets
      "import.meta.env.VITE_WS_URL": JSON.stringify(env.NEXT_PUBLIC_WS_URL || ""),
      "import.meta.env.VITE_WEB_APP_URL": JSON.stringify(env.NEXTAUTH_URL || ""),
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});
