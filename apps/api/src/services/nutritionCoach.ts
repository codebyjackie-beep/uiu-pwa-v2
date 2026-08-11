/**
 * HANDOFF_health-tab-v1.md §2 — AI Nutrition Coach (Part B). Text-only
 * OpenRouter chat, same key/endpoint pattern as recipe drafting
 * (services/openrouter.ts) but free-form conversational output, not JSON.
 *
 * SECRET-TIER DATA — never console.log/console.error message content
 * (CLAUDE.md §4). Only generic error strings are logged by callers.
 */
export interface NutritionCoachEnv {
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
}

export interface CoachChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chatWithCoach(env: NutritionCoachEnv, messages: CoachChatMessage[]): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: env.OPENROUTER_MODEL, messages }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter coach request failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new Error("OpenRouter coach response had no message content");
  return content.trim();
}
