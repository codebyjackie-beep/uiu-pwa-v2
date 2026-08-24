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
 * Product ASIN lookup goes through services/serper.ts (Google SERP via
 * Serper, never a direct Amazon fetch — see that file for why).
 */
import type { OpenRouterEnv } from "./openrouter";
import type { SerperEnv } from "./serper";
import { lookupAsin, buildAffiliateLink } from "./serper";

export interface OrganicDraft {
  targetAccount: "uiu";
  caption: string;
  imageQuery: string;
}

export interface AffiliateDraft {
  targetAccount: "affiliate";
  caption: string;
  imageQuery: string;
  productName: string;
  category: string;
  asin: string;
  affiliateLink: string;
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

const ORGANIC_SYSTEM_PROMPT =
  "You are writing one Instagram feed post caption for @useitup.app, a UK healthy-eating / " +
  "meal-planning / food-waste-reduction app. Tone: warm, practical, food-and-kitchen focused — " +
  "recipe ideas, cooking tips, fridge/food-waste tips, meal-prep encouragement. Never mention " +
  "any product recommendation, purchase link, or Amazon — this account is organic content only. " +
  "Include 3-6 relevant hashtags at the end. Respond with ONLY a JSON object: " +
  '{"caption": string, "imageQuery": string} — imageQuery is a short English phrase (2-6 words) ' +
  "describing a food/kitchen photo that would suit this post, for a stock photo search.";

/** recentCaptionSummaries: short strings (e.g. titles) of recently-posted organic content, to avoid repeats. */
export async function generateOrganicDraft(env: OpenRouterEnv, recentCaptionSummaries: string[]): Promise<OrganicDraft> {
  const userPrompt =
    "Write one new Instagram post idea (recipe tip, cooking tip, or food-waste tip) for a UK audience." +
    (recentCaptionSummaries.length > 0
      ? ` Avoid repeating these recently-posted topics: ${recentCaptionSummaries.join("; ")}.`
      : "");
  const parsed = (await callOpenRouterJson(env, ORGANIC_SYSTEM_PROMPT, userPrompt)) as Partial<OrganicDraft>;
  if (!parsed.caption || !parsed.imageQuery) throw new Error("Organic draft response missing caption/imageQuery");
  return { targetAccount: "uiu", caption: parsed.caption, imageQuery: parsed.imageQuery };
}

const AFFILIATE_IDEA_SYSTEM_PROMPT =
  "You suggest ONE kitchen/cooking/food-storage product to recommend on an Amazon UK affiliate " +
  "Instagram account (@kura.nook), aimed at home cooks. Suggest a specific, commonly-sold product " +
  "type (e.g. \"stainless steel mixing bowls set\", not a vague category like \"kitchen tools\") " +
  "so it can be found by a product search. Respond with ONLY a JSON object: " +
  '{"productName": string, "category": string, "searchQuery": string, "reason": string} — ' +
  "searchQuery is what you'd type into a shopping search engine to find this exact product on amazon.co.uk.";

interface AffiliateIdea {
  productName: string;
  category: string;
  searchQuery: string;
  reason: string;
}

async function suggestAffiliateProduct(env: OpenRouterEnv, recentProductNames: string[]): Promise<AffiliateIdea> {
  const userPrompt =
    "Suggest one kitchen/cooking product to recommend today." +
    (recentProductNames.length > 0 ? ` Do not repeat these recently-recommended products: ${recentProductNames.join("; ")}.` : "");
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
  "You write ONE Instagram feed post caption recommending a specific kitchen product, for an Amazon " +
  "affiliate account (@kura.nook). Tone: genuine, helpful, practical — explain why the product is " +
  "useful in a home kitchen. Do NOT include any disclosure text yourself (it is appended separately) " +
  "and do NOT include a link (also appended separately). Include 3-6 relevant hashtags at the end. " +
  'Respond with ONLY a JSON object: {"caption": string, "imageQuery": string} — imageQuery is a short ' +
  "English phrase (2-6 words) describing a product/kitchen photo for a stock photo search.";

async function writeAffiliateCaption(env: OpenRouterEnv, idea: AffiliateIdea): Promise<{ caption: string; imageQuery: string }> {
  const userPrompt = `Product: ${idea.productName}. Category: ${idea.category}. Why it's worth recommending: ${idea.reason}.`;
  const parsed = (await callOpenRouterJson(env, AFFILIATE_CAPTION_SYSTEM_PROMPT, userPrompt)) as Partial<{ caption: string; imageQuery: string }>;
  if (!parsed.caption || !parsed.imageQuery) throw new Error("Affiliate caption response missing caption/imageQuery");
  return { caption: parsed.caption, imageQuery: parsed.imageQuery };
}

export interface AffiliateEnv extends OpenRouterEnv, SerperEnv {
  AMAZON_ASSOCIATE_TAG: string;
}

/**
 * Full affiliate pipeline: idea -> ASIN lookup -> caption -> disclosure appended by code.
 * Returns null if Serper found no ASIN for the suggested product — callers should skip
 * this slot rather than publish a link-less "affiliate" post or fabricate an ASIN.
 */
export async function generateAffiliateDraft(env: AffiliateEnv, recentProductNames: string[]): Promise<AffiliateDraft | null> {
  const idea = await suggestAffiliateProduct(env, recentProductNames);
  const found = await lookupAsin(env, idea.searchQuery);
  if (!found) return null;
  const { caption, imageQuery } = await writeAffiliateCaption(env, idea);
  const affiliateLink = buildAffiliateLink(found.asin, env.AMAZON_ASSOCIATE_TAG);
  const fullCaption = `${caption}\n\n🔗 ${affiliateLink}\n\n#ad Affiliate link — as an Amazon Associate I earn from qualifying purchases.`;
  return {
    targetAccount: "affiliate",
    caption: fullCaption,
    imageQuery,
    productName: idea.productName,
    category: idea.category,
    asin: found.asin,
    affiliateLink,
  };
}
