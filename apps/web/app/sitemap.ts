import type { MetadataRoute } from "next";
import type { RecipeListPage } from "@uiu/shared";
import { apiGetPublic } from "./lib/api";
import { buildSitemapEntries, staticSitemapEntries } from "./lib/sitemapEntries";

// Must run per request: prerendering at build time would bake in the static-only fallback
// (no Cloudflare bindings at build), and open-next.config.ts has no incremental cache for ISR.
export const dynamic = "force-dynamic";

// Lighthouse 2026-10-25: /sitemap.xml returned HTTP 500. Static public pages + every public recipe
// (canonical /recipes/<_id>, same as the recipe page). Any API failure → static pages only; never throws.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    return await buildSitemapEntries(
      (page, limit) => apiGetPublic<RecipeListPage>(`/api/recipes?limit=${limit}&page=${page}`),
      {
        onError: (message) => console.error("[uiu-web] sitemap recipes fallback:", message),
        onWarn: (message) => console.warn("[uiu-web] sitemap truncated:", message),
      },
    );
  } catch {
    return staticSitemapEntries();
  }
}
