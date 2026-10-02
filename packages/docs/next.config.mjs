import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/**
 * The docs site is built and served by Vercel (`vercel build` then
 * `vercel deploy --prebuilt`), so it needs no `output: "standalone"` bundle.
 * Turbopack finds the monorepo root on its own from the root `package-lock.json`.
 *
 * @type {import("next").NextConfig}
 */
const config = {
  reactStrictMode: true,
};

export default withMDX(config);
