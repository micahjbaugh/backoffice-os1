import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@backoffice/domain", "@backoffice/core"],
  // The Postgres driver is server-only and must never be bundled for the browser.
  serverExternalPackages: ["pg"],
  // Lets the bundle-secret test build into an isolated directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
};

export default nextConfig;
