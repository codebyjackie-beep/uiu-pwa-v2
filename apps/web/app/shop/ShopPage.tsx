"use client";

import { useEffect, useState } from "react";
import type { ApiResponse, ShopRestockItem, ShoppingListItem } from "@uiu/shared";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; parsed: ApiResponse<T> | null }> {
  const res = await fetch(path, init);
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return { res, parsed };
}

function formatCost(value: number): string {
  return `£${value.toFixed(2)}`;
}

export function ShopPage() {
  const [restockItems, setRestockItems] = useState<ShopRestockItem[]>([]);
  const [restockLoading, setRestockLoading] = useState(true);
  const [restockError, setRestockError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const [manualItems, setManualItems] = useState<ShoppingListItem[]>([]);
  const [manualLoading, setManualLoading] = useState(true);
  const [manualText, setManualText] = useState("");
  const [adding, setAdding] = useState(false);

  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void loadRestock();
    void loadManual();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function loadRestock() {
    setRestockLoading(true);
    setRestockError(null);
    const { parsed } = await fetchJson<ShopRestockItem[]>("/api/shop/restock-list");
    if (!parsed || !parsed.ok) {
      setRestockError(parsed && !parsed.ok ? parsed.error.message : "Failed to load, please try again.");
      setRestockLoading(false);
      return;
    }
    setRestockItems(parsed.data);
    setRestockLoading(false);
  }

  async function loadManual() {
    setManualLoading(true);
    const { parsed } = await fetchJson<ShoppingListItem[]>("/api/shopping-list");
    if (parsed && parsed.ok) setManualItems(parsed.data);
    setManualLoading(false);
  }

  async function markBought(item: ShopRestockItem) {
    setPendingId(item.fridgeStockId);
    const { parsed } = await fetchJson(`/api/fridge-stock/${item.fridgeStockId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ needsRestock: false }),
    });
    setPendingId(null);
    if (!parsed || !parsed.ok) {
      setToast("Update failed, please try again.");
      return;
    }
    setRestockItems((prev) => prev.filter((i) => i.fridgeStockId !== item.fridgeStockId));
    setToast(`Marked ${item.ingredientName} as bought.`);
  }

  async function addManualItem() {
    const text = manualText.trim();
    if (!text) return;
    setAdding(true);
    const { parsed } = await fetchJson<ShoppingListItem>("/api/shopping-list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    setAdding(false);
    if (!parsed || !parsed.ok) {
      setToast("Failed to add, please try again.");
      return;
    }
    setManualItems((prev) => [...prev, parsed.data]);
    setManualText("");
  }

  async function toggleManualItem(item: ShoppingListItem) {
    setManualItems((prev) => prev.map((i) => (i._id === item._id ? { ...i, checked: !i.checked } : i)));
    const { parsed } = await fetchJson<ShoppingListItem>(`/api/shopping-list/${item._id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checked: !item.checked }),
    });
    if (!parsed || !parsed.ok) {
      setManualItems((prev) => prev.map((i) => (i._id === item._id ? { ...i, checked: item.checked } : i)));
    }
  }

  async function clearChecked() {
    const checked = manualItems.filter((i) => i.checked);
    if (checked.length === 0) return;
    setManualItems((prev) => prev.filter((i) => !i.checked));
    await Promise.all(checked.map((i) => fetchJson(`/api/shopping-list/${i._id}`, { method: "DELETE" })));
  }

  return (
    <div className="shop-page">
      <h1>Shop</h1>

      {toast ? <p className="admin-drafts-toast">{toast}</p> : null}

      <section className="shop-section">
        <h2>Auto — from your Fridge</h2>
        <p className="admin-drafts-page__sub">
          Items flagged to restock in Fridge, with the cheapest price we found. &quot;Bought&quot; just clears the
          restock flag — use Scan Receipt or Scan Fridge in the Fridge tab to actually add stock back in.
        </p>

        {restockError ? <p className="admin-drafts-error">{restockError}</p> : null}
        {restockLoading ? <p className="admin-drafts-page__sub">Loading…</p> : null}
        {!restockLoading && restockItems.length === 0 && !restockError ? (
          <p className="admin-drafts-page__sub">Nothing to restock right now.</p>
        ) : null}

        <div className="shop-list">
          {restockItems.map((item) => (
            <div key={item.fridgeStockId} className="shop-card">
              <div className="shop-card__main">
                <span className="shop-card__name">{item.ingredientName}</span>
                <span className="shop-card__meta">
                  {item.quantity} {item.unit}
                </span>
                {item.cheapest ? (
                  <span className="shop-card__price">
                    {formatCost(item.cheapest.price)} · {item.cheapest.store}
                  </span>
                ) : (
                  <span className="shop-card__price shop-card__price--pending">no price yet</span>
                )}
              </div>
              <button
                type="button"
                className="wizard-secondary-button"
                disabled={pendingId === item.fridgeStockId}
                onClick={() => markBought(item)}
              >
                Bought
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="shop-section">
        <h2>Manual</h2>
        <p className="admin-drafts-page__sub">Anything else you want to remember to buy.</p>

        <div className="shop-add-form">
          <input
            type="text"
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            placeholder="Add an item…"
            onKeyDown={(e) => {
              if (e.key === "Enter") void addManualItem();
            }}
          />
          <button type="button" className="wizard-primary-button" disabled={adding} onClick={addManualItem}>
            {adding ? "Adding…" : "Add"}
          </button>
        </div>

        {manualLoading ? <p className="admin-drafts-page__sub">Loading…</p> : null}
        {!manualLoading && manualItems.length === 0 ? <p className="admin-drafts-page__sub">No manual items yet.</p> : null}

        <div className="shop-manual-list">
          {manualItems.map((item) => (
            <label key={item._id} className={`shop-manual-item${item.checked ? " shop-manual-item--checked" : ""}`}>
              <input type="checkbox" checked={item.checked} onChange={() => toggleManualItem(item)} />
              <span>{item.text}</span>
            </label>
          ))}
        </div>

        {manualItems.some((i) => i.checked) ? (
          <button type="button" className="wizard-secondary-button" onClick={clearChecked}>
            Clear checked
          </button>
        ) : null}
      </section>
    </div>
  );
}
