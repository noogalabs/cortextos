import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

// Pin Turbopack's workspace root to THIS dashboard directory. Without this,
// Next.js infers the workspace root as the parent cortextos repo (it holds the
// outermost package.json/lockfile), which pulls the sibling `orgs/` tree into
// Turbopack's filesystem walk during `next build`. `orgs/` holds agent runtime
// sandboxes whose Python venvs contain symlinks pointing outside the repo
// (e.g. .../venv/bin/python3.14 -> /opt/homebrew/...), and Turbopack aborts with
// "Symlink ... is invalid, it points out of the filesystem root". Scoping the
// root to the dashboard dir keeps the build inside the app and never traverses
// orgs/. (CI never hit this because the orgs/ nested repo is not checked out
// there; it only surfaces on a full local tree.)
const dashboardRoot = path.dirname(fileURLToPath(import.meta.url));

// Next.js 15.2+ blocks non-localhost origins from /_next/* dev-internal
// resources by default. When the dashboard is accessed over Tailscale, a LAN
// IP, or a reverse proxy, the browser receives the SSR HTML but the client
// bundle cannot finish hydrating because dev-resource requests are rejected —
// useEffect never fires, the CSRF token is never fetched, and the login form
// is stuck.
//
// Set DASHBOARD_ALLOWED_DEV_ORIGINS to a comma-separated list of hostnames or
// IPs to whitelist (e.g. "100.64.95.40,mybox.local,dashboard.example.com").
// Localhost is always allowed. Only reads in development; production builds
// ignore the setting.
const allowedDevOrigins = (process.env.DASHBOARD_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  turbopack: { root: dashboardRoot },
  serverExternalPackages: ['better-sqlite3'],
  ...(allowedDevOrigins.length > 0 && { allowedDevOrigins }),
  async headers() {
    return [
      {
        // Prevent aggressive caching of API routes and pages through the tunnel
        source: '/((?!_next/static).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
