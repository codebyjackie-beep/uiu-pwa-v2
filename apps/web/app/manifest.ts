import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "UseItUp",
    short_name: "UseItUp",
    description: "Plan meals, track your fridge, shop smart, stay healthy.",
    start_url: "/",
    display: "standalone",
    background_color: "#f3ede2",
    theme_color: "#f3ede2",
    share_target: {
      action: "/recipes/share-target",
      method: "GET",
      params: {
        title: "title",
        text: "text",
        url: "url",
      },
    },
    icons: [
      // "USE IT UP!" sticker logo (Jackie, 2026-10-21 round 3C). PNG only — the sticker
      // uses Bricolage Grotesque, which an SVG icon can't load.
      { src: "/icon-192.png?v=2", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-192-maskable.png?v=2", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512-maskable.png?v=2", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
