"use client";

import { useEffect, useMemo, useState } from "react";
import type { ApiResponse, FridgeStockItem } from "@uiu/shared";

interface IngredientOption {
  id: string;
  name: string;
  isPantry: boolean;
}

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
  if (days < 0) return "已過期";
  if (days === 0) return "今日過期";
  return `${days}日後過期`;
}

function expiryClass(days: number): { card: string; text: string } {
  if (days < 0) return { card: "fridge-card--expired", text: "fridge-card__expiry--expired" };
  if (days < 5) return { card: "fridge-card--soon", text: "fridge-card__expiry--soon" };
  return { card: "", text: "" };
}

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
  const [showOcrNotice, setShowOcrNotice] = useState(false);
  const [adding, setAdding] = useState(false);

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
      setError(parsed && !parsed.ok ? parsed.error.message : "讀取失敗，請重試。");
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
      setToast("請填寫食材名、份量同單位。");
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
      setToast(parsed && !parsed.ok ? `加入失敗：${parsed.error.message}` : "加入失敗，請重試。");
      return;
    }
    setItems((prev) => [...prev, parsed.data].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)));
    setNameInput("");
    setSelectedOption(null);
    setQuantity("1");
    setUnit("");
    setToast("已加入雪櫃。");
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
      setToast(parsed && !parsed.ok ? `更新失敗：${parsed.error.message}` : "更新失敗，請重試。");
      return;
    }
    setItems((prev) => prev.map((i) => (i._id === item._id ? parsed.data : i)));
  }

  async function deleteItem(item: FridgeStockItem) {
    setPendingId(item._id);
    const { res } = await fetchJson<{ deleted: true }>(`/api/fridge-stock/${item._id}`, { method: "DELETE" });
    setPendingId(null);
    if (!res.ok) {
      setToast("刪除失敗，請重試。");
      return;
    }
    setItems((prev) => prev.filter((i) => i._id !== item._id));
    setToast("已刪除。");
  }

  const sortedItems = useMemo(() => [...items].sort((a, b) => daysUntil(a.expiresAt) - daysUntil(b.expiresAt)), [items]);

  return (
    <div className="fridge-page">
      <h1>Fridge</h1>
      <p className="admin-drafts-page__sub">你雪櫃入面存貨，按過期日排先。標記「要補貨」嘅嘢會喺 Shop 度顯示。</p>

      {toast ? <p className="admin-drafts-toast">{toast}</p> : null}

      <div className="fridge-add-form">
        <label className="wizard-field fridge-add-form__picker">
          <span>食材</span>
          <input
            type="text"
            value={selectedOption ? selectedOption.name : nameInput}
            onChange={(e) => {
              setSelectedOption(null);
              setNameInput(e.target.value);
            }}
            placeholder="打食材名（例如 chicken breast）"
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
            <span>份量</span>
            <input type="number" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </label>
          <label className="wizard-field">
            <span>單位</span>
            <input type="text" placeholder="g / ml / pc" value={unit} onChange={(e) => setUnit(e.target.value)} />
          </label>
        </div>

        <button type="button" className="wizard-primary-button" disabled={adding} onClick={addItem}>
          {adding ? "加入緊…" : "加入雪櫃"}
        </button>

        <button type="button" className="fridge-ocr-button" onClick={() => setShowOcrNotice(true)}>
          📷 影收據加入
        </button>
        {showOcrNotice ? (
          <p className="admin-drafts-page__sub">呢個功能未接通，請手動輸入。（等揀定 OCR vendor 先接真嘢）</p>
        ) : null}
      </div>

      {error ? <p className="admin-drafts-error">{error}</p> : null}
      {loading ? <p className="admin-drafts-page__sub">載入緊…</p> : null}
      {!loading && sortedItems.length === 0 && !error ? <p className="admin-drafts-page__sub">雪櫃暫時冇存貨。</p> : null}

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
                  要補貨
                </label>
                <button type="button" className="fridge-card__delete" disabled={pendingId === item._id} onClick={() => deleteItem(item)}>
                  刪除
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
