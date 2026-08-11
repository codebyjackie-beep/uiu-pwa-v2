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

interface OffLookupResult {
  found: boolean;
  product: OffProduct | null;
}

async function lookupBarcode(barcode: string): Promise<OffLookupResult> {
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`);
    if (!res.ok) return { found: false, product: null };
    const json = (await res.json()) as {
      status?: number;
      product?: { product_name?: string; nutriments?: Record<string, number> };
    };
    if (json.status !== 1 || !json.product) return { found: false, product: null };
    const n = json.product.nutriments ?? {};
    const caloriesPer100g = n["energy-kcal_100g"];
    if (typeof caloriesPer100g !== "number") return { found: false, product: null };
    return {
      found: true,
      product: {
        name: json.product.product_name?.trim() || "Unknown product",
        caloriesPer100g,
        proteinPer100g: n["proteins_100g"] ?? 0,
        carbsPer100g: n["carbohydrates_100g"] ?? 0,
        fatPer100g: n["fat_100g"] ?? 0,
      },
    };
  } catch {
    return { found: false, product: null };
  }
}

export function BarcodeScan({ onClose, onLogged }: { onClose: () => void; onLogged: (entry: MealLogEntry) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<"scanning" | "looking-up" | "not-found" | "found" | "camera-error">("scanning");
  const [barcode, setBarcode] = useState<string | null>(null);
  const [product, setProduct] = useState<OffProduct | null>(null);
  const [amountGrams, setAmountGrams] = useState("100");
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
    setPhase("scanning");
  }

  async function confirmLog() {
    if (!product) return;
    const grams = Number(amountGrams);
    if (!Number.isFinite(grams) || grams <= 0) {
      setSaveError("Enter a valid amount in grams.");
      return;
    }
    setSaving(true);
    setSaveError(null);
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
              <label className="wizard-field">
                <span>Amount eaten (g)</span>
                <input type="number" min={0} value={amountGrams} onChange={(e) => setAmountGrams(e.target.value)} />
              </label>
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
