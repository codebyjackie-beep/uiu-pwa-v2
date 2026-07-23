/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@uiu/shared"],
};

export default nextConfig;

// Enable Cloudflare bindings in `next dev` (no-op in CI/build).
// Dynamically imported so a missing dev dep never breaks `next build`.
if (process.env.NODE_ENV === "development") {
  import("@opennextjs/cloudflare")
    .then((m) => m.initOpenNextCloudflareForDev?.())
    .catch(() => {});
}
