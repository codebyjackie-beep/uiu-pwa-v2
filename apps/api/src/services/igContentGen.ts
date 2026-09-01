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
}

const HOOK_BODY_CTA_INSTRUCTIONS =
  "Structure the post in three parts, returned as separate JSON fields (never merge them into one string): " +
  '1) "hook" — the very first line, shown before Instagram\'s "more" cutoff (roughly the first 125 ' +
  "characters). It must grab attention on its own: a question, a surprising/counter-intuitive claim, or a " +
  "relatable pain point. NEVER a plain product/feature description or a generic greeting — a reader must " +
  'be able to tell what the post is about from the hook alone. 2) "body" — 2-3 short sentences delivering ' +
  'the actual benefit/tip. 3) "cta" — one short line inviting engagement (comment/save/share), e.g. ' +
  '"Which one would you try first?" or "Save this for your next shop" or "Tag someone who needs this". ' +
  'Respond with ONLY a JSON object: {"hook": string, "body": string, "cta": string, "imageQuery": string} ' +
  "— imageQuery is a short English phrase (2-6 words) for a stock photo search. Do NOT include hashtags " +
  "anywhere — they are added separately by code.";

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
  if (!parsed.hook || !parsed.body || !parsed.cta || !parsed.imageQuery) {
    throw new Error("Organic draft response missing hook/body/cta/imageQuery");
  }
  const hashtags = await researchHashtags(env, `${pillar} ${parsed.imageQuery}`, recentHashtags, ORGANIC_FALLBACK_HASHTAGS);
  const caption = assembleCaption(parsed.hook, parsed.body, parsed.cta, hashtags);
  return { targetAccount: "uiu", pillar, hook: parsed.hook, caption, imageQuery: parsed.imageQuery, hashtags };
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
  const userPrompt = `Product: ${idea.productName}. Category: ${idea.category}. Why it's worth recommending: ${idea.reason}.`;
  const parsed = (await callOpenRouterJson(env, AFFILIATE_CAPTION_SYSTEM_PROMPT, userPrompt)) as Partial<HookBodyCta>;
  if (!parsed.hook || !parsed.body || !parsed.cta || !parsed.imageQuery) {
    throw new Error("Affiliate caption response missing hook/body/cta/imageQuery");
  }
  return { hook: parsed.hook, body: parsed.body, cta: parsed.cta, imageQuery: parsed.imageQuery };
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

    const { hook, body, cta, imageQuery } = await writeAffiliateCaption(env, { ...idea, category: detected.category });
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
    };
  }
  return null;
}
