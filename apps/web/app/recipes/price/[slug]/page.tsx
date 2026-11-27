import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchAllRecipes } from "../../../lib/publicRecipes";
import { toHubRecipes } from "../../../lib/hubPricing";
import { buildItemListJsonLd } from "../../../lib/recipeHub";
import { serializeJsonLd } from "../../../lib/recipeJsonLd";
import {
  PRICE_HUB_MIN_RECIPES,
  priceHubAmount,
  priceHubBySlug,
  priceHubMeta,
  priceHubPath,
  recipesForPriceHub,
  type PriceHubDef,
} from "../../../lib/priceHubs";
import { RecipeHubList, RecipeHubNav } from "../../RecipeHubList";
import { hubNavGroups } from "../../../lib/recipeHubRegistry";

const DEFAULT_OG_IMAGE = "/og-image.png?v=1";

type Params = { params: Promise<{ slug: string }> };

/**
 * Members of one price hub, from the cached public list (shared with /recipes).
 * `null` = API failure (transient, never a 404); too-short lists are handled by the caller.
 */
async function loadHub(def: PriceHubDef) {
  const all = await fetchAllRecipes();
  if (!all) return null;
  const byId = new Map(all.items.map((r) => [r._id, r]));
  const hubItems = toHubRecipes(all.items);
  const members = recipesForPriceHub(def, hubItems);
  return {
    all,
    hubItems,
    members,
    cards: members.flatMap((m) => {
      const card = byId.get(m._id);
      return card ? [card] : [];
    }),
  };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const def = priceHubBySlug(slug);
  if (!def) return { title: "Page not found · UseItUp", robots: { index: false, follow: false } };
  const hub = await loadHub(def);
  // API blip: plain title, no robots tag (a transient error must never get a real hub dropped from Google).
  if (!hub) return { title: `Recipes under ${priceHubAmount(def)} per serving · UseItUp` };
  if (hub.members.length < PRICE_HUB_MIN_RECIPES) {
    return { title: "Page not found · UseItUp", robots: { index: false, follow: false } };
  }
  const meta = priceHubMeta(def, hub.members);
  const url = priceHubPath(def.slug);
  const image = hub.cards.find((r) => r.imageUrl)?.imageUrl;
  return {
    title: meta.title,
    description: meta.description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      siteName: "UseItUp",
      locale: "en_GB",
      title: meta.heading,
      description: meta.description,
      url,
      images: image ? [{ url: image, alt: meta.heading }] : [{ url: DEFAULT_OG_IMAGE, width: 1200, height: 630 }],
    },
    twitter: { card: "summary_large_image", title: meta.heading, description: meta.description, images: [image || DEFAULT_OG_IMAGE] },
  };
}

export default async function PriceHubPage({ params }: Params) {
  const { slug } = await params;
  const def = priceHubBySlug(slug);
  // Unknown slug → real 404, before any API call.
  if (!def) notFound();
  const hub = await loadHub(def);
  if (!hub) {
    return (
      <div className="recipes-page">
        <div className="recipes-page__header">
          <h1>Recipes under {priceHubAmount(def)} per serving</h1>
          <p>Couldn&apos;t load recipes right now — please try again shortly.</p>
        </div>
      </div>
    );
  }
  // Too few fully priced recipes for a useful page → real 404 (also left out of links + sitemap).
  if (hub.members.length < PRICE_HUB_MIN_RECIPES) notFound();

  const meta = priceHubMeta(def, hub.members);
  const jsonLd = buildItemListJsonLd({ name: meta.heading, path: priceHubPath(def.slug), recipes: hub.members });
  // Other live hubs, for crawl depth (this one left out).
  const others = hubNavGroups(hub.hubItems).map((g) => ({
    ...g,
    links: g.links.filter((l) => l.href !== priceHubPath(def.slug)),
  }));

  return (
    <div className="recipes-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
      <div className="recipes-page__header">
        <Link href="/recipes" className="recipes-page__back">
          ← All recipes
        </Link>
        <h1>{meta.heading}</h1>
        <p>{hub.members.length} recipes</p>
        <p className="recipes-page__intro">{meta.intro}</p>
      </div>

      <RecipeHubList recipes={hub.cards} />

      <RecipeHubNav groups={others} />
    </div>
  );
}
