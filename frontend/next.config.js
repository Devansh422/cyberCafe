/** @type {import('next').NextConfig} */

// Two build modes:
//   • dev (default): Next dev server on :4500 proxies /api → Rust backend :5000.
//   • Tauri export (BUILD_EXPORT=1): static export to ./out for bundling in the
//     desktop app. Static export can't proxy, so the UI calls the absolute API
//     base (NEXT_PUBLIC_API_BASE) instead — see src/lib/api.js. Rewrites and
//     `output: export` are mutually exclusive, so they're toggled here.
const isExport = process.env.BUILD_EXPORT === '1';

const nextConfig = {
  reactStrictMode: true,
  ...(isExport
    ? { output: 'export', images: { unoptimized: true } }
    : {
        async rewrites() {
          return [{ source: '/api/:path*', destination: 'http://localhost:5000/api/:path*' }];
        },
      }),
};

module.exports = nextConfig;
