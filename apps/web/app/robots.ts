import type { MetadataRoute } from "next";

// Lighthouse 2026-10-25: /robots.txt returned HTTP 500 (no route). Public pages are crawlable; app and admin pages are not.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/how-it-works", "/recipes", "/privacy"],
        disallow: ["/admin", "/api", "/profile", "/sign-in", "/sign-up"],
      },
    ],
    sitemap: "https://useitup.uk/sitemap.xml",
    host: "https://useitup.uk",
  };
}
