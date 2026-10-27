import type { NextConfig } from "next";

// ─── Sandbox gateway: Server Actions CSRF allowlist ─────────────────────────
const serverActionsAllowedOrigins = [
  "preview-chat-920348d8-b92f-4f06-96e7-4465b3f979f8.space-z.ai",
  "*.space-z.ai",
  "**.space-z.ai",
  "*.fcapp.run",
  "**.fcapp.run",
  "localhost:3000",
  "127.0.0.1:3000",
];

// ─── Phase 13: Security headers ─────────────────────────────────────────────
//
// Applied to every response via the `headers()` function in next.config.ts.
// These headers protect against common web vulnerabilities:
//   - X-Content-Type-Options: nosniff → prevents MIME sniffing
//   - X-Frame-Options: DENY → prevents clickjacking (iframe embedding)
//   - Referrer-Policy: strict-origin-when-cross-origin → limits referrer leakage
//   - Permissions-Policy: camera=(), microphone=(), geolocation=() → disables unused browser APIs
//   - Strict-Transport-Security: max-age=31536000; includeSubDomains → forces HTTPS (HSTS)
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,

  // ─── Security headers ─────────────────────────────────────────────────────
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },

  // allowedDevOrigins silences the "Cross origin request detected" warning.
  allowedDevOrigins: [
    "preview-chat-920348d8-b92f-4f06-96e7-4465b3f979f8.space-z.ai",
    "*.space-z.ai",
    "*.fcapp.run",
  ],

  experimental: {
    serverActions: {
      allowedOrigins: serverActionsAllowedOrigins,
    } as never,
  } as never,
};

export default nextConfig;
