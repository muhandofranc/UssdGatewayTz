/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output bundles node_modules + the .next/server tree
  // into .next/standalone for a small final image. Dockerfile copies
  // just that.
  output: "standalone",
  // pg is pulled in by lib/db.ts but only on the server side; mark it
  // as external so Next doesn't try to inline it into the client
  // bundle.
  serverExternalPackages: ["pg", "bcryptjs", "nodemailer"],
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        // The reset link carries its token in the URL fragment, which
        // browsers already keep out of Referer — no-referrer is belt and
        // braces for that page. no-store keeps it out of shared caches.
        source: "/reset-password",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
