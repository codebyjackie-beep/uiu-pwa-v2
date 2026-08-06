/**
 * HANDOFF_fridge-followup.md #2/#4 — receipt OCR + fridge photo scan, both via
 * OpenRouter's Gemini 2.5 Flash-Lite vision model (shares OPENROUTER_API_KEY
 * with the daily recipe draft agent — see services/openrouter.ts — but a
 * separate [vars] model id so the two don't collide if either changes).
 */
export interface OpenRouterVisionEnv {
  OPENROUTER_API_KEY: string;
  OPENROUTER_VISION_MODEL: string;
}

export interface ScannedItem {
  name: string;
  quantity: number | null;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1]! : trimmed;
  return JSON.parse(candidate);
}

export async function scanImageForItems(env: OpenRouterVisionEnv, imageDataUrl: string, prompt: string): Promise<ScannedItem[]> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENROUTER_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter vision request failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter vision response had no message content");

  const parsed = extractJson(content);
  if (!Array.isArray(parsed)) throw new Error("OpenRouter vision response was not a JSON array");

  return parsed
    .map((raw): ScannedItem | null => {
      if (!raw || typeof raw !== "object") return null;
      const name = (raw as Record<string, unknown>).name;
      const quantity = (raw as Record<string, unknown>).quantity;
      if (typeof name !== "string" || !name.trim()) return null;
      return { name: name.trim(), quantity: typeof quantity === "number" ? quantity : null };
    })
    .filter((item): item is ScannedItem => item !== null);
}
