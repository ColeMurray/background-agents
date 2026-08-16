import path from "path";
import type { NextConfig } from "next";

const monorepoRoot = path.join(__dirname, "../..");

const nextConfig: NextConfig = {
  agentRules: false,
  output: "standalone",
  // Both must match the monorepo root for Turbopack to resolve workspace packages
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
