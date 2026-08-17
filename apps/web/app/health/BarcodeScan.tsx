"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiResponse, MealLogEntry } from "@uiu/shared";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ parsed: ApiResponse<T> | null }> {
  const res = await fetch(path, init);
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return { parsed };
}

interface OffProduct {
  name: string;
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
}

interface QuantityHints {
  totalPieces: number | null;
  totalWeightG: number | null;
}

interface OffLookupResult {
  found: boolean;
  product: OffProduct | null;
  hints: QuantityHints;
}

/** Best-effort parse of OFF's free-text `quantity` (e.g. "8 x 50g", "400g",
 * "8 Hot Dogs") plus the more stable `product_quantity`/`product_quantity_unit`
 * pair, into a total pack weight (g) and total piece count — both nullable,
 * since a large share of OFF products carry neither field. No hardcoded
 * per-food weight table; purely parses what the response itself provides. */
function parseQuantityHints(
  quantity: string | undefined,
  productQuantity: number | undefined,
  productQuantityUnit: string | undefined,
): QuantityHints {
  let totalWeightG: number | null = null;
  let totalPieces: number | null = null;

  if (typeof productQuantity === "number" && productQuantity > 0) {
    const unit = (productQuantityUnit || "g").toLowerCase();
    if (unit === "kg") totalWeightG = productQuantity * 1000;
    else if (unit === "g") totalWeightG = productQuantity;
  }

  const q = (quantity || "").trim();

  // "8 x 50g" / "8x50 g" style multipack — gives both pieces and (if not
  // already known from product_quantity) total weight.
  const multipackMatch = q.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g)\b/i);
  if (multipackMatch) {
    totalPieces = parseFloat(multipackMatch[1]);
    if (totalWeightG == null) {
      let unitVal = parseFloat(multipackMatch[2]);
      if (multipackMatch[3].toLowerCase() === "kg") unitVal *= 1000;
      totalWeightG = totalPieces * unitVal;
    }
  }

  // Pure weight, e.g. "400g" / "300 g e" / "1.2kg".
  if (totalWeightG == null) {
    const weightMatch = q.match(/(\d+(?:\.\d+)?)\s*(kg|g)\b/i);
    if (weightMatch) {
      let val = parseFloat(weightMatch[1]);
      if (weightMatch[2].toLowerCase() === "kg") val *= 1000;
      totalWeightG = val;
    }
  }

  // Piece count with a descriptive word, e.g. "8 Hot Dogs" / "6 sausages" /
  // "10 slices" / "4 pack". A bare number with no unit/word (e.g. "6") is
  // left unresolved — too ambiguous to assume it means pieces.
  if (totalPieces == null) {
    const piecesMatch = q.match(/(\d+)\s*(hot dogs?|sausages?|pieces?|slices?|packs?|items?|ct|count)\b/i);
    if (piecesMatch) totalPieces = parseFloat(piecesMatch[1]);
  }

  return { totalPieces, totalWeightG };
}

async function lookupBarcode(barcode: string): Promise<OffLookupResult> {
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`);
    if (!res.ok) return { found: false, product: null, hints: { totalPieces: null, totalWeightG: null } };
    const json = (await res.json()) as {
      status?: number;
      product?: {
        product_name?: string;
        nutriments?: Record<string, number>;
        quantity?: string;
        product_quantity?: number;
        product_quantity_unit?: string;
      };
    };
    if (json.status !== 1 || !json.product) {
      return { found: false, product: null, hints: { totalPieces: null, totalWeightG: null } };
    }
    const n = json.product.nutriments ?? {};
    const caloriesPer100g = n["energy-kcal_100g"];
    if (typeof caloriesPer100g !== "number") {
      return { found: false, product: null, hints: { totalPieces: null, totalWeightG: null } };
    }
    const hints = parseQuantityHints(
      json.product.quantity,
      json.product.product_quantity,
      json.product.product_quantity_unit,
    );
    return {
      found: true,
      product: {
        name: json.product.product_name?.trim() || "Unknown product",
        caloriesPer100g,
        proteinPer100g: n["proteins_100g"] ?? 0,
        carbsPer100g: n["carbohydrates_100g"] ?? 0,
        fatPer100g: n["fat_100g"] ?? 0,
      },
      hints,
    };
  } catch {
    return { found: false, product: null, hints: { totalPieces: null, totalWeightG: null } };
  }
}

export function BarcodeScan({ onClose, onLogged }: { onClose: () => void; onLogged: (entry: MealLogEntry) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<"scanning" | "looking-up" | "not-found" | "found" | "camera-error">("scanning");
  const [barcode, setBarcode] = useState<string | null>(null);
  const [product, setProduct] = useState<OffProduct | null>(null);
  const [amountGrams, setAmountGrams] = useState("100");
  const [mode, setMode] = useState<"pieces" | "grams">("grams");
  const [totalPieces, setTotalPieces] = useState("");
  const [totalWeightG, setTotalWeightG] = useState("");
  const [piecesEaten, setPiecesEaten] = useState("1");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controls: { stop: () => void } | null = null;

    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        if (!videoRef.current) return;
        controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
          if (cancelled || !result) return;
          const text = result.getText();
          controls?.stop();
          setBarcode(text);
        });
      } catch {
        if (!cancelled) setPhase("camera-error");
      }
    })();

    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, []);

  useEffect(() => {
    if (!barcode) return;
    let cancelled = false;
    setPhase("looking-up");
    (async () => {
      const result = await lookupBarcode(barcode);
      if (cancelled) return;
      if (result.found && result.product) {
        setProduct(result.product);
        setTotalPieces(result.hints.totalPieces != null ? String(result.hints.totalPieces) : "");
        setTotalWeightG(result.hints.totalWeightG != null ? String(result.hints.totalWeightG) : "");
        setMode(result.hints.totalPieces != null && result.hints.totalWeightG != null ? "pieces" : "grams");
        setPhase("found");
      } else {
        setPhase("not-found");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [barcode]);

  function rescan() {
    setBarcode(null);
    setProduct(null);
    setSaveError(null);
    setAmountGrams("100");
    setMode("grams");
    setTotalPieces("");
    setTotalWeightG("");
    setPiecesEaten("1");
    setPhase("scanning");
  }

  function resolveGrams(): number | null {
    if (mode === "grams") {
      const grams = Number(amountGrams);
      if (!Number.isFinite(grams) || grams <= 0) {
        setSaveError("Enter a valid amount in grams.");
        return null;
      }
      return grams;
    }

    const pack = Number(totalWeightG);
    if (!Number.isFinite(pack) || pack <= 0) {
      setSaveError("Enter the pack's total net weight in g.");
      return null;
    }
    const pieces = Number(totalPieces);
    if (!Number.isFinite(pieces) || pieces <= 0) {
      setSaveError("Enter how many pieces are in the pack.");
      return null;
    }
    const eaten = Number(piecesEaten);
    if (!Number.isFinite(eaten) || eaten <= 0) {
      setSaveError("Enter how many pieces you ate.");
      return null;
    }
    return (pack / pieces) * eaten;
  }

  async function confirmLog() {
    if (!product) return;
    setSaveError(null);
    const grams = resolveGrams();
    if (grams == null) return;
    setSaving(true);
    const scale = grams / 100;
    const { parsed } = await fetchJson<MealLogEntry>("/api/health/meal-logs/barcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: `${product.name} (${grams}g)`,
        calories: product.caloriesPer100g * scale,
        protein: product.proteinPer100g * scale,
        carbs: product.carbsPer100g * scale,
        fat: product.fatPer100g * scale,
      }),
    });
    setSaving(false);
    if (!parsed || !parsed.ok) {
      setSaveError(parsed && !parsed.ok ? parsed.error.message : "Failed to log meal.");
      return;
    }
    onLogged(parsed.data);
    onClose();
  }

  return (
    <div className="meal-planner-modal-overlay" onClick={onClose}>
      <div className="meal-planner-modal health-barcode-modal" onClick={(e) => e.stopPropagation()}>
        <div className="meal-planner-modal__header">
          <h3 className="meal-planner-modal__title">Scan a barcode</h3>
          <button type="button" className="meal-planner-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="meal-planner-modal__body">
          {phase === "scanning" ? (
            <>
              <video ref={videoRef} className="health-barcode-video" muted playsInline />
              <p className="admin-drafts-page__sub">Point the camera at a product barcode.</p>
            </>
          ) : null}

          {phase === "camera-error" ? (
            <p className="admin-drafts-error">
              Couldn&apos;t access the camera. Check camera permissions for this site and try again.
            </p>
          ) : null}

          {phase === "looking-up" ? <p className="admin-drafts-page__sub">Looking up product…</p> : null}

          {phase === "not-found" ? (
            <>
              <p className="admin-drafts-error">No product found for that barcode. Try scanning again, or log this meal manually via a photo instead.</p>
              <button type="button" className="wizard-secondary-button" onClick={rescan}>
                Scan again
              </button>
            </>
          ) : null}

          {phase === "found" && product ? (
            <div className="health-barcode-result">
              <p className="health-barcode-result__name">{product.name}</p>
              <p className="admin-drafts-page__sub">
                Per 100g: {Math.round(product.caloriesPer100g)} kcal · {Math.round(product.proteinPer100g)}g protein ·{" "}
                {Math.round(product.carbsPer100g)}g carbs · {Math.round(product.fatPer100g)}g fat
              </p>
              <div className="health-barcode-mode-tabs">
                <button
                  type="button"
                  className={`health-barcode-mode-tab${mode === "pieces" ? " health-barcode-mode-tab--active" : ""}`}
                  onClick={() => setMode("pieces")}
                >
                  By pieces
                </button>
                <button
                  type="button"
                  className={`health-barcode-mode-tab${mode === "grams" ? " health-barcode-mode-tab--active" : ""}`}
                  onClick={() => setMode("grams")}
                >
                  By grams
                </button>
              </div>

              {mode === "pieces" ? (
                <>
                  <div className="wizard-field-row">
                    <label className="wizard-field">
                      <span>Pieces in pack</span>
                      <input type="number" min={0} value={totalPieces} onChange={(e) => setTotalPieces(e.target.value)} />
                    </label>
                    <label className="wizard-field">
                      <span>Pack net weight (g)</span>
                      <input type="number" min={0} value={totalWeightG} onChange={(e) => setTotalWeightG(e.target.value)} />
                    </label>
                  </div>
                  <label className="wizard-field">
                    <span>Pieces eaten</span>
                    <input type="number" min={0} value={piecesEaten} onChange={(e) => setPiecesEaten(e.target.value)} />
                  </label>
                  {(() => {
                    const pack = Number(totalWeightG);
                    const pieces = Number(totalPieces);
                    const eaten = Number(piecesEaten);
                    if (Number.isFinite(pack) && pack > 0 && Number.isFinite(pieces) && pieces > 0 && Number.isFinite(eaten) && eaten > 0) {
                      return <p className="admin-drafts-page__sub">≈ {Math.round((pack / pieces) * eaten)}g</p>;
                    }
                    return null;
                  })()}
                </>
              ) : (
                <label className="wizard-field">
                  <span>Amount eaten (g)</span>
                  <input type="number" min={0} value={amountGrams} onChange={(e) => setAmountGrams(e.target.value)} />
                </label>
              )}
              {saveError ? <p className="admin-drafts-error">{saveError}</p> : null}
              <div className="health-form-actions">
                <button type="button" className="wizard-primary-button" disabled={saving} onClick={() => void confirmLog()}>
                  {saving ? "Logging…" : "Log meal"}
                </button>
                <button type="button" onClick={rescan} disabled={saving}>
                  Scan again
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
