/**
 * HANDOFF_ig-marketing-affiliate-agent-design.md §1 — shared research +
 * content generation, with explicit isolation guardrails (2026-08-24
 * addendum, in response to Jackie asking "won't sharing this mix content up?"):
 *
 *   1. One LLM call generates exactly one draft for exactly one account/type
 *      — never ask for an organic and an affiliate post in the same call.
 *   2. Context isolation — the organic prompt never includes affiliate_products
 *      data, and vice versa. Two functions below, two disjoint system prompts,
 *      no shared prompt text.
 *   3. Affiliate disclosure ("Affiliate link / #ad") is appended by CODE, not
 *      requested from the LLM — Amazon Associates + ASA/FTC require it and it
 *      must not depend on the model remembering to include it.
 *
 * 2026-08-25 addendum (Jackie, after reviewing live posts — "唔吸引、唔知想表達
 * 啲咩" / "人哋睇個post唔會知你個張圖想講啲乜"): every draft is now generated as
 * three explicit parts — hook / body / cta — instead of one opaque caption blob.
 *   - hook: the pre-"more"-cutoff line (~125 chars), must be a question / pain
 *     point / counter-intuitive claim, never a plain spec description. Returned
 *     standalone (not just embedded in caption) because jobs/igContentAgent.ts
 *     composites this exact same string onto the post image (services/brandedImage.ts)
 *     — the same sentence has to work as both the caption opener AND the on-image
 *     headline, so the two must never drift apart.
 *   - body: 2-3 sentences, the actual benefit/tip.
 *   - cta: one engagement line (comment/save/share), appended by the LLM per
 *     the prompt, not fabricated by code (varies more naturally that way).
 * Hashtags are no longer LLM-authored free text — see researchHashtags() below,
 * appended by code after the LLM call, same isolation reasoning as the disclosure.
 *
 * Product ASIN lookup goes through services/serper.ts (Google SERP via
 * Serper, never a direct Amazon fetch — see that file for why).
 */
import type { OpenRouterEnv } from "./openrouter";
import type { SerperEnv } from "./serper";
import { lookupAsin, buildAffiliateLink, scrapeProductImage, searchProductImageByAsin, researchHashtags } from "./serper";
import { detectAmazonCategory, type TargetedCategory } from "./amazonCategory";

const ORGANIC_FALLBACK_HASHTAGS = ["#mealprep", "#foodwasteuk", "#healthyeatinguk", "#kitchentips", "#ukfoodie"];
const AFFILIATE_FALLBACK_HASHTAGS = ["#kitchengadgets", "#amazonfinds", "#homefinds", "#ukhomedecor", "#ukfoodie"];

export interface OrganicDraft {
  targetAccount: "uiu";
  pillar: string;
  hook: string;
  caption: string;
  imageQuery: string;
  /** cc_prompt_atlas_cloud_bg.md — natural-language scene description fed to Atlas Cloud
   * (services/atlasCloudImage.ts) to generate the post's AI background photo. Separate from
   * imageQuery (a short stock-search phrase, kept as the Pexels fallback's search term). */
  backgroundPrompt: string;
  hashtags: string[];
}

export interface AffiliateDraft {
  targetAccount: "affiliate";
  hook: string;
  caption: string;
  imageQuery: string;
  productName: string;
  category: TargetedCategory;
  /** Amazon Associates UK commission rate (%) for `category`, from cc_prompt_commission_rate_filter.md's table — for reporting, not re-derived elsewhere. */
  commissionRate: number;
  /** The real Amazon browse-node text (page title suffix or Best Sellers Rank line) that `category` was matched from — kept for the verification/audit trail, see amazonCategory.ts. */
  rawAmazonCategory: string;
  asin: string;
  affiliateLink: string;
  hashtags: string[];
  /** Real product photo scraped from the ASIN's own Amazon listing page, if found — takes priority over imageQuery/Pexels. */
  productImageUrl?: string;
  productImageSource?: "amazon_scrape" | "images_search";
  /** cc_prompt_atlas_cloud_bg.md — scene description for the AI-generated BACKGROUND only
   * (composited behind the real productImageUrl by brandedImage.ts's 3-layer render — never
   * describes/replaces the product itself, see that file's header comment on why). */
  backgroundPrompt: string;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

async function callOpenRouterJson(env: OpenRouterEnv, systemPrompt: string, userPrompt: string): Promise<unknown> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter request failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter response had no message content");
  return extractJson(content);
}

/** hook first (pre-cutoff, standalone), then body, then cta, then the code-appended hashtag line. */
function assembleCaption(hook: string, body: string, cta: string, hashtags: string[]): string {
  const tagLine = hashtags.length > 0 ? hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ") : "";
  return [hook, body, cta, tagLine].filter((part) => part.length > 0).join("\n\n");
}

interface HookBodyCta {
  hook: string;
  body: string;
  cta: string;
  imageQuery: string;
  backgroundPrompt: string;
}

const HOOK_BODY_CTA_INSTRUCTIONS =
  "Structure the post in three parts, returned as separate JSON fields (never merge them into one string): " +
  '1) "hook" — the very first line, shown before Instagram\'s "more" cutoff (roughly the first 125 ' +
  "characters). It must grab attention on its own: a question, a surprising/counter-intuitive claim, or a " +
  "relatable pain point. NEVER a plain product/feature description or a generic greeting — a reader must " +
  'be able to tell what the post is about from the hook alone. 2) "body" — 2-3 short sentences delivering ' +
  'the actual benefit/tip. 3) "cta" — one short line inviting engagement (comment/save/share), e.g. ' +
  '"Which one would you try first?" or "Save this for your next shop" or "Tag someone who needs this". ' +
  'Respond with ONLY a JSON object: {"hook": string, "body": string, "cta": string, "imageQuery": string, ' +
  '"backgroundPrompt": string} — imageQuery is a short English phrase (2-6 words) for a stock photo search ' +
  "(fallback only). backgroundPrompt is a one-sentence, vivid visual description for an AI image generator " +
  "to create the post's background photo — describe a real photographic scene that matches the post's " +
  "topic (e.g. lighting, setting, mood, styling), and explicitly state it must contain NO text, NO logos, " +
  "and NO product packaging/labels. Do NOT include hashtags anywhere — they are added separately by code.";

const ORGANIC_SYSTEM_PROMPT =
  "You are writing one Instagram feed post for @useitup.app, a UK healthy-eating / meal-planning / " +
  "food-waste-reduction app. Tone: warm, practical, food-and-kitchen focused — recipe ideas, cooking " +
  "tips, fridge/food-waste tips, meal-prep encouragement. Never mention any product recommendation, " +
  "purchase link, or Amazon — this account is organic content only. You will be told which content " +
  "pillar to write for (recipe / tip / waste-reduction / behind-the-scenes) — stay strictly within that " +
  "pillar. " +
  HOOK_BODY_CTA_INSTRUCTIONS;

/**
 * recentCaptionSummaries: short strings of recently-posted organic content, to avoid repeats.
 * recentHashtags: hashtags used in recent drafts (any account), so this batch's set doesn't repeat them.
 * pillar: one of UIU_PILLARS (jobs/igContentAgent.ts owns the rotation state) — the LLM must stay on-pillar.
 */
export async function generateOrganicDraft(
  env: OpenRouterEnv & SerperEnv,
  recentCaptionSummaries: string[],
  recentHashtags: string[],
  pillar: string,
): Promise<OrganicDraft> {
  const userPrompt =
    `Write one new Instagram post for the "${pillar}" content pillar, for a UK audience.` +
    (recentCaptionSummaries.length > 0 ? ` Avoid repeating these recently-posted topics: ${recentCaptionSummaries.join("; ")}.` : "");
  const parsed = (await callOpenRouterJson(env, ORGANIC_SYSTEM_PROMPT, userPrompt)) as Partial<HookBodyCta>;
  if (!parsed.hook || !parsed.body || !parsed.cta || !parsed.imageQuery || !parsed.backgroundPrompt) {
    throw new Error("Organic draft response missing hook/body/cta/imageQuery/backgroundPrompt");
  }
  const hashtags = await researchHashtags(env, `${pillar} ${parsed.imageQuery}`, recentHashtags, ORGANIC_FALLBACK_HASHTAGS);
  const caption = assembleCaption(parsed.hook, parsed.body, parsed.cta, hashtags);
  return { targetAccount: "uiu", pillar, hook: parsed.hook, caption, imageQuery: parsed.imageQuery, backgroundPrompt: parsed.backgroundPrompt, hashtags };
}

/**
 * 2026-09-01 (cc_prompt_commission_rate_filter.md): niche broadened from kitchen-only to
 * "home lifestyle" so the pool of biddable products covers all of the Amazon Associates UK
 * categories Jackie approved as targeted — Kitchen stays the priority (4.5% commission, the
 * original core niche) but Furniture/Home/Home Improvement/Lawn & Garden/Pets/Tools (3% each)
 * are now equally valid picks, not a last-resort fallback. Whatever the LLM suggests here still
 * gets independently verified against Amazon's real category (amazonCategory.ts) before a draft
 * is built — this prompt only shapes *what's suggested*, it is not the enforcement point.
 */
const AFFILIATE_IDEA_SYSTEM_PROMPT =
  "You suggest ONE product to recommend on an Amazon UK affiliate Instagram account (@useitup.app), " +
  "aimed at people who care about their home — kitchen, furniture, home decor/improvement, garden, " +
  "pets, or household tools. Prioritise kitchen/cooking/food-storage products when a good idea fits, " +
  "but furniture, home organisation, garden, pet, and tool products are equally valid — do not limit " +
  "yourself to the kitchen. Suggest a specific, commonly-sold product type (e.g. \"stainless steel " +
  "mixing bowls set\" or \"raised garden bed planter box\", not a vague category like \"kitchen tools\") " +
  "so it can be found by a product search. Respond with ONLY a JSON object: " +
  '{"productName": string, "category": string, "searchQuery": string, "reason": string} — ' +
  "searchQuery is what you'd type into a shopping search engine to find this exact product on amazon.co.uk.";

interface AffiliateIdea {
  productName: string;
  category: string;
  searchQuery: string;
  reason: string;
}

async function suggestAffiliateProduct(env: OpenRouterEnv, recentProductNames: string[], avoidCategory: string | null): Promise<AffiliateIdea> {
  const userPrompt =
    "Suggest one home-lifestyle product (kitchen, furniture, home decor/improvement, garden, pets, or tools) to recommend today." +
    (recentProductNames.length > 0 ? ` Do not repeat these recently-recommended products: ${recentProductNames.join("; ")}.` : "") +
    (avoidCategory ? ` The previous post was in the "${avoidCategory}" category — pick a DIFFERENT category this time, do not post two in a row from the same category.` : "");
  const parsed = (await callOpenRouterJson(env, AFFILIATE_IDEA_SYSTEM_PROMPT, userPrompt)) as Partial<AffiliateIdea>;
  if (!parsed.productName || !parsed.searchQuery) throw new Error("Affiliate idea response missing productName/searchQuery");
  return {
    productName: parsed.productName,
    category: parsed.category ?? "kitchen",
    searchQuery: parsed.searchQuery,
    reason: parsed.reason ?? "",
  };
}

const AFFILIATE_CAPTION_SYSTEM_PROMPT =
  "You write ONE Instagram feed post recommending a specific product, for an Amazon UK affiliate " +
  "account (@useitup.app) focused on home life — kitchen, furniture, home decor/improvement, garden, " +
  "pets, and household tools. Tone: genuine, helpful, practical — explain why the product is useful " +
  "for the home, in whichever of those areas it fits. Do NOT include any disclosure text or a link " +
  "yourself (both appended separately). " +
  HOOK_BODY_CTA_INSTRUCTIONS;

async function writeAffiliateCaption(env: OpenRouterEnv, idea: AffiliateIdea): Promise<HookBodyCta> {
  const userPrompt =
    `Product: ${idea.productName}. Category: ${idea.category}. Why it's worth recommending: ${idea.reason}. ` +
    "The backgroundPrompt must describe a lifestyle/setting scene the product would naturally be used in " +
    "or shown near (e.g. the kind of room/surface/context), NOT the product itself — a real photo of the " +
    "actual product is composited on top separately, so the background must not depict any product.";
  const parsed = (await callOpenRouterJson(env, AFFILIATE_CAPTION_SYSTEM_PROMPT, userPrompt)) as Partial<HookBodyCta>;
  if (!parsed.hook || !parsed.body || !parsed.cta || !parsed.imageQuery || !parsed.backgroundPrompt) {
    throw new Error("Affiliate caption response missing hook/body/cta/imageQuery/backgroundPrompt");
  }
  return { hook: parsed.hook, body: parsed.body, cta: parsed.cta, imageQuery: parsed.imageQuery, backgroundPrompt: parsed.backgroundPrompt };
}

export interface AffiliateEnv extends OpenRouterEnv, SerperEnv {
  AMAZON_ASSOCIATE_TAG: string;
}

const MAX_AFFILIATE_ATTEMPTS = 2;

/**
 * Full affiliate pipeline: idea -> ASIN lookup -> real-category verification -> hook/body/cta ->
 * hashtags -> disclosure appended by code. Returns null if no in-scope candidate could be found
 * within MAX_AFFILIATE_ATTEMPTS tries — callers should skip this slot rather than publish a
 * link-less/off-niche "affiliate" post or fabricate a category.
 *
 * avoidCategory: jobs/igContentAgent.ts's persisted lastAffiliateCategory (now the *verified*
 * category from a prior run, see amazonCategory.ts), so two posts in a row don't land in the
 * same commission-rate category.
 *
 * 2026-09-01 (cc_prompt_commission_rate_filter.md): the LLM's self-reported `idea.category` is
 * freeform and unverified — it can't be trusted to actually be "≥4% Kitchen" or one of the
 * targeted 3% categories (Furniture/Home/Home Improvement/Lawn & Garden/Pets Products/Tools).
 * Once an ASIN is found, detectAmazonCategory() checks the *real* Amazon listing (page title +
 * Best Sellers Rank text, see that file) and only a match against the targeted list proceeds —
 * anything else (0% categories, off-niche categories like Electronics/Toys, or a listing whose
 * category couldn't be read at all) is discarded rather than guessed at, same "skip, don't
 * fabricate" rule as a missing ASIN or missing image below.
 */
export async function generateAffiliateDraft(
  env: AffiliateEnv,
  recentProductNames: string[],
  recentHashtags: string[],
  avoidCategory: string | null,
): Promise<AffiliateDraft | null> {
  for (let attempt = 0; attempt < MAX_AFFILIATE_ATTEMPTS; attempt++) {
    let idea = await suggestAffiliateProduct(env, [...recentProductNames], avoidCategory);
    if (avoidCategory && idea.category.toLowerCase() === avoidCategory.toLowerCase()) {
      // Model ignored the avoid-category instruction — one retry with a blunter constraint before giving up.
      idea = await suggestAffiliateProduct(env, [...recentProductNames, idea.productName], avoidCategory);
    }

    const found = await lookupAsin(env, idea.searchQuery);
    if (!found) continue; // no ASIN for this idea — try the next attempt rather than giving up immediately

    const detected = await detectAmazonCategory(env, found.productUrl);
    if (!detected.ok) {
      console.log(`[uiu-api] igContentGen: skipped "${idea.productName}" (${found.asin}) — category check failed: ${detected.reason}${detected.rawAmazonCategory ? ` (raw: "${detected.rawAmazonCategory}")` : ""}`);
      continue;
    }
    if (avoidCategory && detected.category === avoidCategory) {
      console.log(`[uiu-api] igContentGen: skipped "${idea.productName}" (${found.asin}) — verified category "${detected.category}" repeats the previous post's category`);
      continue;
    }

    const { hook, body, cta, imageQuery, backgroundPrompt } = await writeAffiliateCaption(env, { ...idea, category: detected.category });
    const affiliateLink = buildAffiliateLink(found.asin, env.AMAZON_ASSOCIATE_TAG);
    const hashtags = await researchHashtags(env, `${detected.category} ${idea.productName}`, recentHashtags, AFFILIATE_FALLBACK_HASHTAGS);
    const body_ = assembleCaption(hook, body, cta, hashtags);
    const fullCaption = `${body_}\n\n🔗 ${affiliateLink}\n\n#ad Affiliate link — as an Amazon Associate I earn from qualifying purchases.`;
    // Prefer the real listing photo scraped from this exact ASIN's own Amazon page over the
    // generic Pexels stock search below — searchPhoto(imageQuery) is only reached if this is null.
    // 2026-08-30: scrapeProductImage's markdown extraction is flaky (see searchProductImageByAsin's
    // header comment in serper.ts) so fall back to an ASIN-verified Google Images search.
    const productImage =
      (await scrapeProductImage(env, found.productUrl).catch(() => null)) ??
      (await searchProductImageByAsin(env, found.asin).catch(() => null));
    return {
      targetAccount: "affiliate",
      hook,
      caption: fullCaption,
      imageQuery,
      productName: idea.productName,
      category: detected.category,
      commissionRate: detected.rate,
      rawAmazonCategory: detected.rawAmazonCategory,
      asin: found.asin,
      affiliateLink,
      hashtags,
      productImageUrl: productImage?.imageUrl,
      productImageSource: productImage?.source,
      backgroundPrompt,
    };
  }
  return null;
}

/**
 * cc_prompt_multiproduct_collage.md (2026-09-01) — "Pattern 2" catalog-grid post: 9 same-theme
 * products in one image instead of generateAffiliateDraft()'s one-product-per-post. This function
 * only decides WHAT the collage contains (theme's product list, per-product category verification,
 * caption copy) — rendering the grid PNG (services/collageImage.ts) and storing/publishing it stays
 * in jobs/igContentAgent.ts, same separation as the single-product flow (this file returns a source
 * photo URL; igContentAgent.ts's buildBrandedImageUrl does the actual compositing).
 *
 * One LLM call requests a theme's headline/copy plus ~12 CANDIDATE product ideas (buffer above the
 * 9 needed, since some will fail ASIN lookup or land outside the targeted commission-rate
 * categories) — NOT 9-12 separate suggestAffiliateProduct()+writeAffiliateCaption() calls, which
 * would be 18-24 OpenRouter round-trips for one post. Each candidate is still independently
 * ASIN-looked-up and detectAmazonCategory()-verified below, same "skip, don't fabricate" rule as
 * generateAffiliateDraft() — the LLM's freeform idea never becomes a draft's category unchecked.
 */
const AFFILIATE_COLLAGE_SYSTEM_PROMPT =
  "You plan ONE multi-product Instagram catalog post for an Amazon UK affiliate account " +
  "(@useitup.app) focused on home life — kitchen, furniture, home decor/improvement, garden, pets, " +
  "and household tools. You will be given a theme; suggest specific, commonly-sold product types " +
  "that fit it (e.g. \"stainless steel mixing bowls set\", not a vague category like \"kitchen tools\") " +
  "so each can be found by a product search. Respond with ONLY a JSON object: " +
  '{"headline": string, "subtitle": string, "hookQuestion": string, "cta": string, "products": ' +
  '[{"productName": string, "searchQuery": string, "benefitLine": string}, ...]} — ' +
  "headline is a short punchy on-image title for the theme (e.g. \"9 Kitchen Gadgets Under £20\"), " +
  "subtitle is a one-line badge under it, hookQuestion is the caption's opening line (a question " +
  "that makes the reader want to see the list), cta is one short engagement line (comment/save/share), " +
  "searchQuery is what you'd type into a shopping search engine to find that exact product on " +
  "amazon.co.uk, and benefitLine is a short (under 8 words) reason to want it — shown both under the " +
  "product's photo in the grid AND as its caption bullet, so it must work as both. Provide exactly " +
  "12 products so some can be dropped if unavailable. Do NOT include hashtags or a link anywhere — " +
  "both are added separately by code.";

export interface CollageProductIdea {
  productName: string;
  searchQuery: string;
  benefitLine: string;
}

interface CollageIdea {
  headline: string;
  subtitle: string;
  hookQuestion: string;
  cta: string;
  products: CollageProductIdea[];
}

async function suggestCollageIdea(env: OpenRouterEnv, theme: string, recentProductNames: string[]): Promise<CollageIdea> {
  const userPrompt =
    `Theme: "${theme}". Suggest 12 candidate products for a UK audience.` +
    (recentProductNames.length > 0 ? ` Avoid repeating these recently-recommended products: ${recentProductNames.join("; ")}.` : "");
  const parsed = (await callOpenRouterJson(env, AFFILIATE_COLLAGE_SYSTEM_PROMPT, userPrompt)) as Partial<CollageIdea>;
  if (!parsed.headline || !parsed.subtitle || !parsed.hookQuestion || !parsed.cta || !Array.isArray(parsed.products) || parsed.products.length === 0) {
    throw new Error("Collage idea response missing headline/subtitle/hookQuestion/cta/products");
  }
  return {
    headline: parsed.headline,
    subtitle: parsed.subtitle,
    hookQuestion: parsed.hookQuestion,
    cta: parsed.cta,
    products: parsed.products.filter((p): p is CollageProductIdea => Boolean(p?.productName && p?.searchQuery && p?.benefitLine)),
  };
}

export interface ResolvedCollageProduct {
  productName: string;
  asin: string;
  affiliateLink: string;
  category: TargetedCategory;
  commissionRate: number;
  rawAmazonCategory: string;
  imageUrl: string;
  benefitLine: string;
}

/** ASIN lookup -> real-category verification -> real product photo, for one collage candidate. Returns
 * null (never a guess) if any step fails — same discard rule generateAffiliateDraft() uses. */
async function resolveCollageCandidate(env: AffiliateEnv, candidate: CollageProductIdea): Promise<ResolvedCollageProduct | null> {
  const found = await lookupAsin(env, candidate.searchQuery);
  if (!found) return null;

  const detected = await detectAmazonCategory(env, found.productUrl);
  if (!detected.ok) return null;

  const productImage =
    (await scrapeProductImage(env, found.productUrl).catch(() => null)) ?? (await searchProductImageByAsin(env, found.asin).catch(() => null));
  if (!productImage?.imageUrl) return null;

  return {
    productName: candidate.productName,
    asin: found.asin,
    affiliateLink: buildAffiliateLink(found.asin, env.AMAZON_ASSOCIATE_TAG),
    category: detected.category,
    commissionRate: detected.rate,
    rawAmazonCategory: detected.rawAmazonCategory,
    imageUrl: productImage.imageUrl,
    benefitLine: candidate.benefitLine,
  };
}

// collageImage.ts's 3x3 grid renderer requires exactly this many products (see that file's header
// comment on why V1 is a fixed grid) — a theme attempt either resolves all of them or is discarded,
// no partial-grid rendering.
const COLLAGE_TARGET_COUNT = 9;
const COLLAGE_RESOLVE_CHUNK_SIZE = 4;
const MAX_COLLAGE_THEME_ATTEMPTS = 2;

/** Resolves candidates in bounded-concurrency chunks (not all 12 at once, not fully serial —
 * a collage does up to 3 Serper calls per candidate, ~36 calls unbounded is both slow and risks
 * a single Worker invocation's time limit), stopping once COLLAGE_TARGET_COUNT succeed. */
async function resolveCollageCandidates(env: AffiliateEnv, candidates: CollageProductIdea[]): Promise<ResolvedCollageProduct[]> {
  const resolved: ResolvedCollageProduct[] = [];
  const seenAsins = new Set<string>();
  for (let i = 0; i < candidates.length && resolved.length < COLLAGE_TARGET_COUNT; i += COLLAGE_RESOLVE_CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + COLLAGE_RESOLVE_CHUNK_SIZE);
    const results = await Promise.all(chunk.map((c) => resolveCollageCandidate(env, c).catch(() => null)));
    for (const r of results) {
      if (r && !seenAsins.has(r.asin) && resolved.length < COLLAGE_TARGET_COUNT) {
        seenAsins.add(r.asin);
        resolved.push(r);
      }
    }
  }
  return resolved;
}

function assembleCollageCaption(hookQuestion: string, products: ResolvedCollageProduct[], cta: string, hashtags: string[]): string {
  const bullets = products.map((p) => `✅ ${p.productName} — ${p.benefitLine}`).join("\n");
  const tagLine = hashtags.length > 0 ? hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ") : "";
  return [
    hookQuestion,
    bullets,
    cta,
    "🔗 Full list + direct links → useitup.uk/shop-affiliate",
    tagLine,
    "#ad Affiliate link — as an Amazon Associate I earn from qualifying purchases.",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export interface AffiliateCollageDraft {
  targetAccount: "affiliate";
  postType: "collage";
  theme: string;
  headline: string;
  subtitle: string;
  caption: string;
  hashtags: string[];
  products: ResolvedCollageProduct[]; // exactly COLLAGE_TARGET_COUNT
}

/**
 * Full collage pipeline: theme -> candidate ideas -> per-candidate ASIN/category/photo resolution
 * -> caption assembly. Returns null if fewer than COLLAGE_MIN_ACCEPTABLE candidates resolved after
 * MAX_COLLAGE_THEME_ATTEMPTS tries — caller should skip this run rather than publish a thin/off-niche
 * collage. `theme` is chosen by the caller (jobs/igContentAgent.ts owns the rotation counter, same
 * pattern as nextUiuPillar) so this function stays a pure "given a theme, build the post" step.
 */
export async function generateAffiliateCollageDraft(env: AffiliateEnv, recentProductNames: string[], theme: string): Promise<AffiliateCollageDraft | null> {
  for (let attempt = 0; attempt < MAX_COLLAGE_THEME_ATTEMPTS; attempt++) {
    let idea: CollageIdea;
    try {
      idea = await suggestCollageIdea(env, theme, recentProductNames);
    } catch (err) {
      console.error("[uiu-api] igContentGen: suggestCollageIdea failed:", err instanceof Error ? err.message : String(err));
      continue;
    }

    const resolved = await resolveCollageCandidates(env, idea.products);
    if (resolved.length < COLLAGE_TARGET_COUNT) {
      console.log(`[uiu-api] igContentGen: collage theme "${theme}" only resolved ${resolved.length}/${COLLAGE_TARGET_COUNT} products — ${attempt + 1 < MAX_COLLAGE_THEME_ATTEMPTS ? "retrying" : "giving up"}`);
      continue;
    }
    const products = resolved.slice(0, COLLAGE_TARGET_COUNT);

    const categories = Array.from(new Set(products.map((p) => p.category)));
    const hashtags = await researchHashtags(env, `${theme} ${categories.join(" ")}`, [], AFFILIATE_FALLBACK_HASHTAGS);
    const caption = assembleCollageCaption(idea.hookQuestion, products, idea.cta, hashtags);

    return {
      targetAccount: "affiliate",
      postType: "collage",
      theme,
      // The idea prompt asks for 12 candidate products (buffer for lookup failures) but the
      // grid always ships exactly COLLAGE_TARGET_COUNT — the LLM sometimes echoes "12" into its
      // own headline text (e.g. "12 Kitchen Gadgets..."), which would then visibly mismatch the
      // 9-cell grid. Force any leading count in the headline to match what's actually shown.
      headline: idea.headline.replace(/^\d+(?=\s)/, String(COLLAGE_TARGET_COUNT)),
      subtitle: idea.subtitle,
      caption,
      hashtags,
      products,
    };
  }
  return null;
}
