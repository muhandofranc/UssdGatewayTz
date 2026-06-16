/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output bundles node_modules + the .next/server tree
  // into .next/standalone for a small final image. Dockerfile copies
  // just that.
  output: "standalone",
  // pg is pulled in by lib/db.ts but only on the server side; mark it
  // as external so Next doesn't try to inline it into the client
  // bundle.
  serverExternalPackages: ["pg", "bcryptjs"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
