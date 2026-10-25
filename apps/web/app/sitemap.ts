import type { MetadataRoute } from "next";

// Lighthouse 2026-10-25: /sitemap.xml returned HTTP 500. Lists the public, signed-out pages only.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://useitup.uk";
  return [
    { url: `${base}/how-it-works`, changeFrequency: "monthly", priority: 1 },
    { url: `${base}/recipes`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/privacy`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
