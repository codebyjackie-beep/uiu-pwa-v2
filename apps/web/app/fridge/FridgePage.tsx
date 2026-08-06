"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiResponse, FridgeStockItem, FridgeStockSource } from "@uiu/shared";

interface IngredientOption {
  id: string;
  name: string;
  isPantry: boolean;
}

interface ScannedItem {
  name: string;
  quantity: number | null;
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
  ocr: { button: "📷 Scan receipt", endpoint: "/api/fridge-stock/ocr", source: "ocr", heading: "Confirm scanned receipt items" },
  "photo-scan": { button: "📷 Scan fridge", endpoint: "/api/fridge-stock/scan-fridge", source: "photo-scan", heading: "Confirm scanned fridge items" },
};

export function FridgePage() {
  const [items, setItems] = useState<FridgeStockItem[]>([]);
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
  const [confirming, setConfirming] = useState(false);
  const ocrInputRef = useRef<HTMLInputElement>(null);
  const photoScanInputRef = useRef<HTMLInputElement>(null);

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

  async function deleteItem(item: FridgeStockItem) {
    setPendingId(item._id);
    const { res } = await fetchJson<{ deleted: true }>(`/api/fridge-stock/${item._id}`, { method: "DELETE" });
    setPendingId(null);
    if (!res.ok) {
      setToast("Delete failed, please try again.");
      return;
    }
    setItems((prev) => prev.filter((i) => i._id !== item._id));
    setToast("Deleted.");
  }

  function triggerScan(kind: ScanKind) {
    setScanKind(kind);
    (kind === "ocr" ? ocrInputRef : photoScanInputRef).current?.click();
  }

  async function handleScanFile(kind: ScanKind, file: File) {
    setScanKind(kind);
    setScanning(true);
    setScanError(null);
    setReviewItems(null);
    const form = new FormData();
    form.append("image", file);
    const { parsed } = await fetchJson<ScannedItem[]>(SCAN_LABELS[kind].endpoint, { method: "POST", body: form });
    setScanning(false);
    if (!parsed || !parsed.ok) {
      setScanError(parsed && !parsed.ok ? parsed.error.message : "Scan failed, please try again.");
      return;
    }
    if (parsed.data.length === 0) {
      setScanError("No items recognized in that photo. Please enter manually.");
      return;
    }
    setReviewItems(parsed.data.map((item) => ({ ...item, unit: "pc", include: true })));
  }

  function updateReviewItem(index: number, patch: Partial<ScanReviewItem>) {
    setReviewItems((prev) => (prev ? prev.map((item, i) => (i === index ? { ...item, ...patch } : item)) : prev));
  }

  function cancelScan() {
    setScanKind(null);
    setReviewItems(null);
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
          <button type="button" className="wizard-secondary-button" onClick={() => triggerScan("ocr")} disabled={scanning}>
            {SCAN_LABELS.ocr.button}
          </button>
          <button type="button" className="wizard-secondary-button" onClick={() => triggerScan("photo-scan")} disabled={scanning}>
            {SCAN_LABELS["photo-scan"].button}
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
            </div>
          ))}
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
                <button type="button" className="fridge-card__delete" disabled={pendingId === item._id} onClick={() => deleteItem(item)}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
