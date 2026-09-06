import type { NextConfig } from "next"
import path from "node:path"
import { fileURLToPath } from "node:url"

const djangoPublicOrigin =
  process.env.DJANGO_PUBLIC_ORIGIN ?? "http://127.0.0.1:8001"
const distDir = process.env.FORKLUCK_NEXT_DIST_DIR ?? ".next"
// The pnpm workspace root; standalone output is traced from here, so the
// entry lands at .next/standalone/apps/web/server.js beside hoisted modules.
const workspaceRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

const nextConfig: NextConfig = {
  // Browser acceptance tests use a separate build directory so they can run
  // without writing into (or stopping) an active local `next dev` process.
  distDir,
  // Next automatically adds its generated type directory to the selected
  // config. Give acceptance builds their own file so `pnpm test:acceptance`
  // never rewrites the editor-facing tsconfig.json.
  typescript: {
    tsconfigPath:
      distDir === ".next-acceptance"
        ? "tsconfig.acceptance.json"
        : "tsconfig.json",
  },
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  deploymentId: process.env.DEPLOYMENT_VERSION,
  // Native binding behind the Qwen PDF rasterizer (lib/invoice-extract.ts):
  // left to Node's own require, since Turbopack cannot place it in a chunk.
  serverExternalPackages: ["@napi-rs/canvas"],
  // sharp loads libvips with dlopen, which the file tracer cannot follow, so
  // the standalone output shipped the package without its shared library and
  // every photo read failed on the server. Copy the library files by hand.
  outputFileTracingIncludes: {
    "/**/*": [
      "../../node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/*/lib/**",
    ],
  },
  // Keep the dev-tools badge out of the sidebar's account row.
  devIndicators: {
    position: "bottom-right",
  },
  experimental: {
    serverActions: {
      // CSV and spreadsheet files are base64-encoded before parsing. The
      // server action validates the encoded payload again at 8 MB.
      bodySizeLimit: "10mb",
    },
  },
  async redirects() {
    return [
      // Channel linking lives under Integrations; OAuth callbacks already in
      // flight still name the old path.
      {
        source: "/settings/sales-channels",
        destination: "/integrations/sales/connections",
        permanent: true,
      },
    ]
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/api/auth/:path*",
          destination: `${djangoPublicOrigin}/api/auth/:path*`,
        },
        {
          source: "/api/billing/:path*",
          destination: `${djangoPublicOrigin}/api/billing/:path*`,
        },
        {
          source: "/api/integrations/:path*",
          destination: `${djangoPublicOrigin}/api/integrations/:path*`,
        },
      ],
      afterFiles: [],
      fallback: [],
    }
  },
}

export default nextConfig
