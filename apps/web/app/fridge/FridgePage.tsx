"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiResponse, FridgeStockItem, FridgeStockSource } from "@uiu/shared";
import { FridgeRecipeGenModal } from "./FridgeRecipeGenModal";
import { ImpactCard } from "./ImpactCard";
import { ReminderToggle } from "./ReminderToggle";
import { useGuestGate } from "../components/GuestGate";

interface IngredientOption {
  id: string;
  name: string;
  isPantry: boolean;
}

interface ScannedItem {
  name: string;
  quantity: number | null;
  /** AI estimate of days the item keeps from purchase; null = server default (5 days fresh, 365 pantry). */
  shelfLifeDays: number | null;
}

interface ScanResult {
  items: ScannedItem[];
  /** Receipt date (YYYY-MM-DD) when the AI could read one. */
  purchaseDate: string | null;
  /** Receipts only: the item count the receipt prints vs how many we found. Null when the receipt prints none. */
  countCheck?: { itemsSold: number; found: number } | null;
}

/** Local calendar date as YYYY-MM-DD (for the "Bought on" date input). */
function localIsoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * "Mon 27 Oct" — when an item bought on `boughtOn` and keeping `days` days runs out.
 * Adds the year ("Mon 25 Oct 2027") only when that date falls in a different year from today.
 */
function useByLabel(boughtOn: string, days: number | null): string {
  if (!days) return "";
  const [y, m, d] = boughtOn.split("-").map(Number);
  const date = new Date(y!, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + days);
  const otherYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(otherYear ? { year: "numeric" as const } : {}),
  });
}

interface ScanReviewItem extends ScannedItem {
  unit: string;
  include: boolean;
}

type ScanKind = "ocr" | "photo-scan";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; parsed: ApiResponse<T> | null }> {
  const res = await fetch(path, init);
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return { res, parsed };
}

function daysUntil(iso: string): number {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return Infinity;
  return Math.ceil((target - Date.now()) / (1000 * 60 * 60 * 24));
}

function expiryLabel(days: number): string {
  if (days < 0) return "Expired";
  if (days === 0) return "Expires today";
  return `Expires in ${days}d`;
}

function expiryClass(days: number): { card: string; text: string } {
  if (days < 0) return { card: "fridge-card--expired", text: "fridge-card__expiry--expired" };
  if (days < 5) return { card: "fridge-card--soon", text: "fridge-card__expiry--soon" };
  return { card: "", text: "" };
}

const SCAN_LABELS: Record<ScanKind, { button: string; endpoint: string; source: FridgeStockSource; heading: string }> = {
  ocr: { button: "Scan receipt", endpoint: "/api/fridge-stock/ocr", source: "ocr", heading: "Confirm scanned receipt items" },
  "photo-scan": { button: "Scan fridge", endpoint: "/api/fridge-stock/scan-fridge", source: "photo-scan", heading: "Confirm scanned fridge items" },
};

function ReceiptIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2h12a1 1 0 0 1 1 1v18l-2.5-1.5L14 21l-2.5-1.5L9 21l-2.5-1.5L4 21V3a1 1 0 0 1 1-1z" />
      <line x1="8" y1="7" x2="16" y2="7" />
      <line x1="8" y1="11" x2="16" y2="11" />
      <line x1="8" y1="15" x2="13" y2="15" />
    </svg>
  );
}

function FridgeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <line x1="5" y1="9" x2="19" y2="9" />
      <line x1="8" y1="5" x2="8" y2="7" />
      <line x1="8" y1="12" x2="8" y2="14" />
    </svg>
  );
}

function ChefHatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 18v-6a6 6 0 0 1 4-5.66 3 3 0 0 1 5.9-1.05A5 5 0 0 1 20 10a5 5 0 0 1-2 10.4V18" transform="translate(0,-1)" />
      <path d="M8 12a4 4 0 0 1 8 0v6H8z" />
      <line x1="6" y1="21" x2="18" y2="21" />
    </svg>
  );
}

export function FridgePage() {
  // Premium buttons ask for an account before opening the file picker / modal (guest -> sign-up sheet).
  const { requireAccount } = useGuestGate();
  const [items, setItems] = useState<FridgeStockItem[]>([]);
  const [impactVersion, setImpactVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const [ingredientOptions, setIngredientOptions] = useState<IngredientOption[]>([]);
  const [nameInput, setNameInput] = useState("");
  const [selectedOption, setSelectedOption] = useState<IngredientOption | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("");
  const [adding, setAdding] = useState(false);

  const [scanKind, setScanKind] = useState<ScanKind | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [reviewItems, setReviewItems] = useState<ScanReviewItem[] | null>(null);
  const [countCheck, setCountCheck] = useState<ScanResult["countCheck"]>(null);
  const [boughtOn, setBoughtOn] = useState(() => localIsoDate(new Date()));
  const [confirming, setConfirming] = useState(false);
  const ocrInputRef = useRef<HTMLInputElement>(null);
  const photoScanInputRef = useRef<HTMLInputElement>(null);

  const [genModalOpen, setGenModalOpen] = useState(false);

  useEffect(() => {
    void loadItems();
    void loadIngredientOptions();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function loadItems() {
    setLoading(true);
    setError(null);
    const { parsed } = await fetchJson<FridgeStockItem[]>("/api/fridge-stock");
    if (!parsed || !parsed.ok) {
      setError(parsed && !parsed.ok ? parsed.error.message : "Failed to load, please try again.");
      setLoading(false);
      return;
    }
    setItems(parsed.data);
    setLoading(false);
  }

  async function loadIngredientOptions() {
    const { parsed } = await fetchJson<IngredientOption[]>("/api/fridge-stock/ingredient-options");
    if (parsed && parsed.ok) setIngredientOptions(parsed.data);
  }

  const suggestions = useMemo(() => {
    const q = nameInput.trim().toLowerCase();
    if (!q || selectedOption) return [];
    return ingredientOptions.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 8);
  }, [nameInput, ingredientOptions, selectedOption]);

  async function addItem() {
    const trimmedName = (selectedOption?.name ?? nameInput).trim();
    const qty = Number(quantity);
    if (!trimmedName || !Number.isFinite(qty) || qty <= 0 || !unit.trim()) {
      setToast("Please fill in item name, quantity, and unit.");
      return;
    }
    setAdding(true);
    const { parsed } = await fetchJson<FridgeStockItem>("/api/fridge-stock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ingredientName: trimmedName,
        canonicalIngredientId: selectedOption?.id ?? null,
        quantity: qty,
        unit: unit.trim(),
        source: "manual",
      }),
    });
    setAdding(false);
    if (!parsed || !parsed.ok) {
      setToast(parsed && !parsed.ok ? `Failed to add: ${parsed.error.message}` : "Failed to add, please try again.");
      return;
    }
    setItems((prev) => [...prev, parsed.data].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)));
    setNameInput("");
    setSelectedOption(null);
    setQuantity("1");
    setUnit("");
    setToast("Added to fridge.");
  }

  async function toggleRestock(item: FridgeStockItem) {
    setPendingId(item._id);
    const { parsed } = await fetchJson<FridgeStockItem>(`/api/fridge-stock/${item._id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ needsRestock: !item.needsRestock }),
    });
    setPendingId(null);
    if (!parsed || !parsed.ok) {
      setToast(parsed && !parsed.ok ? `Update failed: ${parsed.error.message}` : "Update failed, please try again.");
      return;
    }
    setItems((prev) => prev.map((i) => (i._id === item._id ? parsed.data : i)));
  }

  /** Impact: "used" / "wasted" are logged (fridge_events) before the item is removed; no outcome = added by mistake. */
  async function deleteItem(item: FridgeStockItem, outcome?: "used" | "wasted") {
    setPendingId(item._id);
    const q = outcome ? `?outcome=${outcome}` : "";
    const { res, parsed } = await fetchJson<{ deleted: true }>(`/api/fridge-stock/${item._id}${q}`, { method: "DELETE" });
    setPendingId(null);
    if (!res.ok || !parsed?.ok) {
      setToast("Update failed, please try again.");
      return;
    }
    setItems((prev) => prev.filter((i) => i._id !== item._id));
    setToast(outcome === "used" ? "Nice — marked as used." : outcome === "wasted" ? "Marked as thrown away." : "Removed.");
    setImpactVersion((v) => v + 1);
  }

  function triggerScan(kind: ScanKind) {
    if (!requireAccount()) return;
    setScanKind(kind);
    (kind === "ocr" ? ocrInputRef : photoScanInputRef).current?.click();
  }

  async function handleScanFile(kind: ScanKind, file: File) {
    setScanKind(kind);
    setScanning(true);
    setScanError(null);
    setReviewItems(null);
    setCountCheck(null);
    const form = new FormData();
    form.append("image", file);
    const { parsed } = await fetchJson<ScanResult>(SCAN_LABELS[kind].endpoint, { method: "POST", body: form });
    setScanning(false);
    if (!parsed || !parsed.ok) {
      setScanError(parsed && !parsed.ok ? parsed.error.message : "Scan failed, please try again.");
      return;
    }
    // Receipt date read by the AI starts the clock; otherwise today. The user can change it before confirming.
    setBoughtOn(kind === "ocr" && parsed.data.purchaseDate ? parsed.data.purchaseDate : localIsoDate(new Date()));
    if (parsed.data.items.length === 0) {
      setScanError("No items recognized in that photo. Please enter manually.");
      return;
    }
    setReviewItems(
      parsed.data.items.map((item) => ({
        ...item,
        quantity: item.quantity && item.quantity > 0 ? item.quantity : 1,
        unit: "pc",
        include: true,
      })),
    );
    setCountCheck(parsed.data.countCheck ?? null);
  }

  function updateReviewItem(index: number, patch: Partial<ScanReviewItem>) {
    setReviewItems((prev) => (prev ? prev.map((item, i) => (i === index ? { ...item, ...patch } : item)) : prev));
  }

  function cancelScan() {
    setScanKind(null);
    setReviewItems(null);
    setCountCheck(null);
    setScanError(null);
  }

  async function confirmScan() {
    if (!reviewItems || !scanKind) return;
    const toAdd = reviewItems.filter((item) => item.include && item.name.trim() && item.unit.trim());
    if (toAdd.length === 0) {
      setToast("No items selected to add.");
      return;
    }
    setConfirming(true);
    let addedCount = 0;
    for (const item of toAdd) {
      const { parsed } = await fetchJson<FridgeStockItem>("/api/fridge-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ingredientName: item.name.trim(),
          canonicalIngredientId: null,
          quantity: item.quantity && item.quantity > 0 ? item.quantity : 1,
          unit: item.unit.trim(),
          source: SCAN_LABELS[scanKind].source,
          purchasedAt: boughtOn,
          shelfLifeDays: item.shelfLifeDays,
        }),
      });
      if (parsed && parsed.ok) addedCount += 1;
    }
    setConfirming(false);
    cancelScan();
    setToast(`Added ${addedCount} of ${toAdd.length} item(s).`);
    void loadItems();
  }

  const sortedItems = useMemo(() => [...items].sort((a, b) => daysUntil(a.expiresAt) - daysUntil(b.expiresAt)), [items]);

  return (
    <div className="fridge-page">
      <h1>Fridge</h1>
      <p className="admin-drafts-page__sub">Your fridge stock, sorted by expiry date. Items marked &quot;Restock&quot; show up in Shop.</p>

      {toast ? <p className="admin-drafts-toast">{toast}</p> : null}

      <div className="fridge-add-form">
        <label className="wizard-field fridge-add-form__picker">
          <span>Item</span>
          <input
            type="text"
            value={selectedOption ? selectedOption.name : nameInput}
            onChange={(e) => {
              setSelectedOption(null);
              setNameInput(e.target.value);
            }}
            placeholder="Type an item name (e.g. chicken breast)"
          />
          {suggestions.length > 0 ? (
            <div className="fridge-add-form__suggestions">
              {suggestions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className="fridge-add-form__suggestion"
                  onClick={() => {
                    setSelectedOption(opt);
                    setNameInput(opt.name);
                  }}
                >
                  {opt.name}
                </button>
              ))}
            </div>
          ) : null}
        </label>

        <div className="wizard-field-row">
          <label className="wizard-field">
            <span>Quantity</span>
            <input type="number" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </label>
          <label className="wizard-field">
            <span>Unit</span>
            <input type="text" placeholder="g / ml / pc" value={unit} onChange={(e) => setUnit(e.target.value)} />
          </label>
        </div>

        <button type="button" className="wizard-primary-button" disabled={adding} onClick={addItem}>
          {adding ? "Adding…" : "Add to fridge"}
        </button>

        <div className="fridge-scan-buttons">
          <button type="button" className="wizard-secondary-button fridge-scan-button" onClick={() => triggerScan("ocr")} disabled={scanning}>
            <ReceiptIcon /> {SCAN_LABELS.ocr.button}
          </button>
          <button type="button" className="wizard-secondary-button fridge-scan-button" onClick={() => triggerScan("photo-scan")} disabled={scanning}>
            <FridgeIcon /> {SCAN_LABELS["photo-scan"].button}
          </button>
          <button type="button" className="wizard-secondary-button fridge-scan-button" onClick={() => { if (requireAccount()) setGenModalOpen(true); }}>
            <ChefHatIcon /> Cook with what I have
          </button>
        </div>
        <input
          ref={ocrInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleScanFile("ocr", file);
          }}
        />
        <input
          ref={photoScanInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleScanFile("photo-scan", file);
          }}
        />
        {scanning ? <p className="admin-drafts-page__sub">Analyzing photo…</p> : null}
        {scanError ? <p className="admin-drafts-error">{scanError}</p> : null}
      </div>

      {reviewItems ? (
        <div className="fridge-scan-review">
          <h2>{scanKind ? SCAN_LABELS[scanKind].heading : "Confirm scanned items"}</h2>
          <p className="admin-drafts-page__sub">Review before adding — nothing is saved until you confirm.</p>
          <label className="fridge-scan-review__bought">
            <span>Bought on</span>
            <input
              type="date"
              value={boughtOn}
              max={localIsoDate(new Date())}
              min={localIsoDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))}
              onChange={(e) => e.target.value && setBoughtOn(e.target.value)}
            />
          </label>
          {countCheck && countCheck.found !== countCheck.itemsSold ? (
            <p className="fridge-scan-note">
              {countCheck.found > countCheck.itemsSold
                ? `Your receipt lists ${countCheck.itemsSold} items but we found ${countCheck.found} (including any non-food we left out). Please untick anything you didn't buy.`
                : `Your receipt lists ${countCheck.itemsSold} items but we found ${countCheck.found}. Some may be missing — add them by hand.`}
            </p>
          ) : null}
          {reviewItems.map((item, index) => (
            <div key={index} className="fridge-scan-review__row">
              <input
                type="checkbox"
                checked={item.include}
                onChange={(e) => updateReviewItem(index, { include: e.target.checked })}
              />
              <input
                type="text"
                value={item.name}
                onChange={(e) => updateReviewItem(index, { name: e.target.value })}
                placeholder="Item name"
              />
              <input
                type="number"
                min={0}
                step="any"
                value={item.quantity ?? ""}
                onChange={(e) => updateReviewItem(index, { quantity: e.target.value ? Number(e.target.value) : null })}
                placeholder="Qty"
              />
              <input
                type="text"
                value={item.unit}
                onChange={(e) => updateReviewItem(index, { unit: e.target.value })}
                placeholder="unit"
              />
              <label className="fridge-scan-review__keeps">
                <span>Keeps</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  value={item.shelfLifeDays ?? ""}
                  onChange={(e) => updateReviewItem(index, { shelfLifeDays: e.target.value ? Math.max(1, Math.min(365, Math.round(Number(e.target.value)))) : null })}
                  placeholder="5"
                  aria-label={`Days ${item.name || "this item"} keeps`}
                />
                <span>days{item.shelfLifeDays ? ` · use by ${useByLabel(boughtOn, item.shelfLifeDays)}` : ""}</span>
              </label>
            </div>
          ))}
          <div className="fridge-scan-review__add">
            <button
              type="button"
              className="wizard-primary-button"
              disabled={confirming}
              onClick={() =>
                setReviewItems((prev) =>
                  prev ? [...prev, { name: "", quantity: 1, unit: "pc", include: true, shelfLifeDays: 7 } as ScanReviewItem] : prev,
                )
              }
            >
              + Add item
            </button>
          </div>
          <div className="fridge-scan-review__actions">
            <button type="button" className="wizard-primary-button" disabled={confirming} onClick={confirmScan}>
              {confirming ? "Adding…" : "Confirm and add"}
            </button>
            <button type="button" onClick={cancelScan} disabled={confirming}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <ImpactCard version={impactVersion} />
      <ReminderToggle />

      {error ? <p className="admin-drafts-error">{error}</p> : null}
      {loading ? <p className="admin-drafts-page__sub">Loading…</p> : null}
      {!loading && sortedItems.length === 0 && !error ? <p className="admin-drafts-page__sub">Your fridge is empty.</p> : null}

      <div className="fridge-list">
        {sortedItems.map((item) => {
          const days = daysUntil(item.expiresAt);
          const cls = expiryClass(days);
          return (
            <div key={item._id} className={`fridge-card ${cls.card}`}>
              <div className="fridge-card__main">
                <span className="fridge-card__name">{item.ingredientName}</span>
                <span className="fridge-card__meta">
                  {item.quantity} {item.unit}
                </span>
                <span className={`fridge-card__expiry ${cls.text}`}>{expiryLabel(days)}</span>
              </div>
              <div className="fridge-card__actions">
                <label className="fridge-card__restock">
                  <input
                    type="checkbox"
                    checked={item.needsRestock}
                    disabled={pendingId === item._id}
                    onChange={() => toggleRestock(item)}
                  />
                  Restock
                </label>
                <div className="fridge-card__outcome">
                  <button type="button" className="fridge-card__used" disabled={pendingId === item._id} onClick={() => deleteItem(item, "used")}>
                    Used
                  </button>
                  <button type="button" className="fridge-card__binned" disabled={pendingId === item._id} onClick={() => deleteItem(item, "wasted")}>
                    Binned
                  </button>
                </div>
                <button type="button" className="fridge-card__delete" disabled={pendingId === item._id} onClick={() => deleteItem(item)} aria-label={`Remove ${item.ingredientName} (added by mistake)`}>
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {genModalOpen ? <FridgeRecipeGenModal items={sortedItems} onClose={() => setGenModalOpen(false)} /> : null}
    </div>
  );
}
