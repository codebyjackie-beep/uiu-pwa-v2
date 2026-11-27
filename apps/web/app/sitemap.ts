import type { MetadataRoute } from "next";
import type { RecipeListPage } from "@uiu/shared";
import { apiGetPublic } from "./lib/api";
import { buildSitemapResult, createCachedSitemap, staticSitemapEntries } from "./lib/sitemapEntries";

// Must run per request: prerendering at build time would bake in the static-only fallback
// (no Cloudflare bindings at build), and open-next.config.ts has no incremental cache for ISR.
// So `revalidate` can't cache this route; createCachedSitemap keeps the last good build in isolate memory instead.
export const dynamic = "force-dynamic";

const getEntries = createCachedSitemap(() =>
  buildSitemapResult(
    (page, limit, signal) => apiGetPublic<RecipeListPage>(`/api/recipes?limit=${limit}&page=${page}`, signal),
    {
      onError: (message) => console.error("[uiu-web] sitemap recipes fallback:", message),
      onWarn: (message) => console.warn("[uiu-web] sitemap truncated:", message),
    },
  ),
);

// Lighthouse 2026-10-25: /sitemap.xml returned HTTP 500. Static public pages + every public recipe
// (canonical /recipes/<_id>, same as the recipe page). Any API failure → last good build, else static pages only; never throws.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    return await getEntries();
  } catch {
    return staticSitemapEntries();
  }
}
