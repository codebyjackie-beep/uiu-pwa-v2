"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { computeShoppingListStoreTotals, formatPricesChecked, isStockLikeName, PANTRY_STAPLE_LABEL, STOCK_PRICED_LABEL } from "@uiu/shared";
import type {
  AffiliateProduct,
  ApiResponse,
  ShopPricesStamp,
  ShopRestockItem,
  ShoppingListItem,
  ShoppingListPriceOption,
} from "@uiu/shared";
import { PricesChecked } from "../components/PricesChecked";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; parsed: ApiResponse<T> | null }> {
  const res = await fetch(path, init);
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return { res, parsed };
}

function formatCost(value: number): string {
  return `£${value.toFixed(2)}`;
}

const OPTIONS_PREVIEW = 6;

function formatPerUnit(o: ShoppingListPriceOption): string | null {
  if (!o.perUnit) return null;
  return o.perUnit.unit === "each" ? `${formatCost(o.perUnit.value)} each` : `${formatCost(o.perUnit.value)}/${o.perUnit.unit}`;
}

/** "Tesco £3.30 · 1kg · £3.30/kg" — "size not listed" when the pack is unknown, £/unit left out. */
function optionSummary(o: ShoppingListPriceOption): string {
  return [`${o.store} ${formatCost(o.price)}`, o.packLabel ?? "size not listed", formatPerUnit(o)].filter(Boolean).join(" · ");
}

const sameOption = (a: ShoppingListPriceOption, b: ShoppingListPriceOption) => a.storeKey === b.storeKey && a.title === b.title && a.price === b.price;

export function ShopPage() {
  const [restockItems, setRestockItems] = useState<ShopRestockItem[]>([]);
  const [restockLoading, setRestockLoading] = useState(true);
  const [restockError, setRestockError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const [manualItems, setManualItems] = useState<ShoppingListItem[]>([]);
  const [manualLoading, setManualLoading] = useState(true);
  const [manualText, setManualText] = useState("");
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());

  const [toast, setToast] = useState<string | null>(null);

  const [kitchenPicks, setKitchenPicks] = useState<AffiliateProduct[]>([]);
  const [pricesStamp, setPricesStamp] = useState<number | null>(null);

  useEffect(() => {
    void loadRestock();
    void loadManual();
    void loadKitchenPicks();
    void loadPricesStamp();
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

  async function loadPricesStamp() {
    // Display-only note — a failure just leaves the date out.
    const { parsed } = await fetchJson<ShopPricesStamp>("/api/shop/prices-stamp");
    if (parsed && parsed.ok) setPricesStamp(parsed.data.priceCacheStamp);
  }

  async function loadKitchenPicks() {
    // /api/affiliate-products already sorts by lastUsedAt desc — most-recent-first, take top 4.
    const { parsed } = await fetchJson<AffiliateProduct[]>("/api/affiliate-products");
    if (parsed && parsed.ok) setKitchenPicks(parsed.data.slice(0, 4));
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

  function toggleIn(setter: (fn: (prev: Set<string>) => Set<string>) => void, id: string) {
    setter((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  // Ticked items drop out of the totals straight away — recomputed on the client, no refetch.
  const storeTotals = computeShoppingListStoreTotals(manualItems);
  const priceStamp = manualItems.reduce<number | null>((max, i) => {
    const t = i.prices?.stamp ? Date.parse(i.prices.stamp) : Number.NaN;
    return Number.isFinite(t) && (max === null || t > max) ? t : max;
  }, null);

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

        <PricesChecked stamp={pricesStamp} />

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
                    {formatCost(item.cheapest.price)}{isStockLikeName(item.canonicalName) ? "" : ` · ${item.cheapest.store}`}
                  </span>
                ) : item.isPantry ? (
                  <span className="shop-card__price shop-card__price--pending">{PANTRY_STAPLE_LABEL}</span>
                ) : (
                  <span className="shop-card__price shop-card__price--pending">no price yet</span>
                )}
                {item.cheapest && isStockLikeName(item.canonicalName) ? (
                  <span className="shop-card__stock">{STOCK_PRICED_LABEL}</span>
                ) : null}
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
          {manualItems.map((item) => {
            const prices = item.prices ?? null;
            const best = prices ? (prices.bestValue ?? prices.cheapestPack) : null;
            const isOpen = !!prices && expanded.has(item._id);
            const all = showAll.has(item._id);
            const options = prices ? (all ? prices.options : prices.options.slice(0, OPTIONS_PREVIEW)) : [];
            const stock = isStockLikeName(item.canonicalName);
            return (
              <div key={item._id} className={`shop-manual-item${item.checked ? " shop-manual-item--checked" : ""}`}>
                <div className="shop-manual-item__row">
                  <label className="shop-manual-item__check">
                    <input type="checkbox" checked={item.checked} onChange={() => toggleManualItem(item)} />
                    <span className="shop-manual-item__body">
                      <span className="shop-manual-item__text">{item.text}</span>
                      {best && prices ? (
                        <>
                          <span className="shop-manual-item__price">{optionSummary(best)}</span>
                          {!sameOption(best, prices.cheapestPack) ? (
                            <span className="shop-manual-item__cheapest">
                              Cheapest pack: {prices.cheapestPack.store} {formatCost(prices.cheapestPack.price)}
                            </span>
                          ) : null}
                          {stock ? <span className="shop-manual-item__cheapest">{STOCK_PRICED_LABEL}</span> : null}
                        </>
                      ) : (
                        <span className="shop-manual-item__price shop-manual-item__price--none">No price yet</span>
                      )}
                    </span>
                  </label>
                  {prices ? (
                    <button
                      type="button"
                      className="shop-manual-item__toggle"
                      aria-expanded={isOpen}
                      aria-label={isOpen ? `Hide prices for ${item.text}` : `Show all prices for ${item.text}`}
                      onClick={() => toggleIn(setExpanded, item._id)}
                    >
                      {isOpen ? "▴" : "▾"}
                    </button>
                  ) : null}
                </div>
                {isOpen && prices ? (
                  <div className="shop-options">
                    {options.map((o) => (
                      <div key={`${o.storeKey}|${o.title}|${o.price}`} className="shop-option">
                        <div className="shop-option__main">
                          <span className="shop-option__store">{o.store}</span>
                          <span className="shop-option__title">{o.title}</span>
                          <span className="shop-option__meta">
                            {[o.packLabel ?? "size not listed", formatPerUnit(o)].filter(Boolean).join(" · ")}
                            {o.packAssumed ? " (assumed)" : ""}
                          </span>
                          {prices.bestValue && sameOption(o, prices.bestValue) ? <span className="shop-option__tag">Best value</span> : null}
                          {sameOption(o, prices.cheapestPack) ? <span className="shop-option__tag shop-option__tag--cheap">Cheapest</span> : null}
                        </div>
                        <span className="shop-option__price">{formatCost(o.price)}</span>
                      </div>
                    ))}
                    {!all && prices.options.length > OPTIONS_PREVIEW ? (
                      <button type="button" className="shop-options__more" onClick={() => toggleIn(setShowAll, item._id)}>
                        Show all {prices.options.length}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {storeTotals.length > 0 ? (
          <div className="shop-store-totals">
            <h3>If you shop at one store</h3>
            {storeTotals.map((t) => (
              <div key={t.storeKey} className="shop-store-totals__row">
                <span>{t.store}</span>
                <span>
                  {formatCost(t.total)} <span className="shop-store-totals__count">({t.itemsPriced}/{t.itemsTotal} priced)</span>
                </span>
              </div>
            ))}
            <p className="shop-store-totals__note">
              Cheapest pack of each item · {formatPricesChecked(priceStamp ?? pricesStamp) ?? "Prices checked recently"}
            </p>
          </div>
        ) : null}

        {manualItems.some((i) => i.checked) ? (
          <button type="button" className="wizard-secondary-button" onClick={clearChecked}>
            Clear checked
          </button>
        ) : null}
      </section>

      <section className="shop-section">
        <h2>Kitchen Picks</h2>
        <p className="admin-drafts-page__sub">Products we&apos;ve recommended on Instagram.</p>

        {kitchenPicks.length > 0 ? (
          <div className="kitchen-picks-preview">
            {kitchenPicks.map((p) => (
              <div key={p.asin} className="kitchen-picks-preview__item">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="kitchen-picks-preview__image" src={p.imageUrl} alt={p.productName} />
                <span className="kitchen-picks-preview__name">{p.productName}</span>
              </div>
            ))}
          </div>
        ) : null}

        <Link href="/shop-affiliate" className="wizard-secondary-button">
          Browse Kitchen Picks
        </Link>
      </section>
    </div>
  );
}
