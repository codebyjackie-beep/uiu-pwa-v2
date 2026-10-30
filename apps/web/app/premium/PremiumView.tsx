"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApiResponse, MyPlan, PremiumFeature } from "@uiu/shared";
import styles from "./premium.module.css";

const FEATURE_LABELS: Record<PremiumFeature, string> = {
  coach: "Nutrition Coach messages",
  meal_plan_wizard: "AI meal plan wizard",
  barcode: "Barcode scans",
  receipt_scan: "Receipt scans",
  video_import: "Video recipe imports",
  fridge_recipe: "Fridge-to-recipe",
  ai_other: "Meal photos, fridge photos and recipe imports",
};

const FEATURE_ORDER: PremiumFeature[] = ["coach", "fridge_recipe", "receipt_scan", "video_import", "ai_other", "meal_plan_wizard", "barcode"];

const PERKS = [
  "AI Nutrition Coach",
  "AI meal plan wizard",
  "Barcode scanning",
  "Fridge photo and receipt scanning",
  "Recipe import from links, photos and videos",
  "Fridge-to-recipe",
  "Meal photo logging",
  "Cook-mode AI assistant",
];

type Interval = "month" | "year";

const PRICES: Record<Interval, { label: string; per: string; note?: string }> = {
  month: { label: "£2.99", per: "per month" },
  year: { label: "£24.99", per: "per year", note: "Save 30%" },
};

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function daysLeft(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  return ms > 0 ? Math.ceil(ms / (24 * 60 * 60 * 1000)) : 0;
}

async function postJson<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  const res = await fetch(path, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return ((await res.json().catch(() => null)) as ApiResponse<T> | null) ?? { ok: false, error: { code: "network", message: "Could not reach the server" } };
}

export function PremiumView() {
  const [plan, setPlan] = useState<MyPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Interval | "portal" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [justPaid, setJustPaid] = useState(false);

  const loadPlan = useCallback(async () => {
    try {
      const res = await fetch("/api/me/plan", { cache: "no-store" });
      const json = (await res.json()) as ApiResponse<MyPlan>;
      if (json.ok) {
        setPlan(json.data);
        setLoadError(null);
      } else {
        setLoadError(json.error.message);
      }
    } catch {
      setLoadError("Could not load your plan");
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") setJustPaid(true);
    void loadPlan();
  }, [loadPlan]);

  async function startCheckout(interval: Interval) {
    setBusy(interval);
    setActionError(null);
    const res = await postJson<{ url: string }>("/api/billing/checkout", { interval });
    if (res.ok && res.data.url) {
      window.location.href = res.data.url;
      return;
    }
    setActionError(res.ok ? "Could not start checkout" : res.error.message);
    setBusy(null);
  }

  async function openPortal() {
    setBusy("portal");
    setActionError(null);
    const res = await postJson<{ url: string }>("/api/billing/portal");
    if (res.ok && res.data.url) {
      window.location.href = res.data.url;
      return;
    }
    setActionError(res.ok ? "Could not open subscription settings" : res.error.message);
    setBusy(null);
  }

  const isPremium = plan?.plan === "premium";
  const isTrial = plan?.plan === "trial";
  const trialDays = daysLeft(plan?.trialEndsAt);
  const accessUntil = formatDate(plan?.premiumUntil);

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>UseItUp Premium</h1>

      {justPaid ? (
        <p className={styles.notice} role="status">
          Thanks for subscribing. Premium can take a few seconds to switch on. Refresh if it still shows Free.
        </p>
      ) : null}

      <section className={styles.card} aria-labelledby="plan-status">
        <h2 id="plan-status" className={styles.sectionTitle}>
          Your plan
        </h2>
        {loadError ? <p className={styles.error}>{loadError}</p> : null}
        {!plan && !loadError ? <p className={styles.muted}>Loading…</p> : null}
        {plan ? (
          <>
            <p className={styles.planName}>{isPremium ? "Premium" : isTrial ? "Free trial" : "Free"}</p>
            {isPremium && accessUntil ? <p className={styles.muted}>Access until {accessUntil}</p> : null}
            {isTrial && trialDays !== null ? (
              <p className={styles.muted}>
                {trialDays > 0 ? `${trialDays} day${trialDays === 1 ? "" : "s"} left of your free trial. No card needed.` : "Your free trial has ended."}
              </p>
            ) : null}
            {!isPremium && !isTrial ? <p className={styles.muted}>Upgrade to unlock the AI features below.</p> : null}
          </>
        ) : null}
      </section>

      {/* Free users have no AI allowance — showing "0 / 100" bars read as 100 free uses (Jackie 2026-10-30). */}
      {plan && (isPremium || isTrial) ? (
        <section className={styles.card} aria-labelledby="usage">
          <h2 id="usage" className={styles.sectionTitle}>
            This month
          </h2>
          <ul className={styles.usageList}>
            {FEATURE_ORDER.map((feature) => {
              const u = plan.usage[feature];
              const unlimited = u.limit === null;
              const pct = unlimited || !u.limit ? 0 : Math.min(100, Math.round((u.used / u.limit) * 100));
              return (
                <li key={feature} className={styles.usageItem}>
                  <div className={styles.usageHead}>
                    <span>{FEATURE_LABELS[feature]}</span>
                    <span className={styles.muted}>{unlimited ? "Unlimited" : `${u.used} / ${u.limit}`}</span>
                  </div>
                  {unlimited ? null : (
                    <div className={styles.bar} aria-hidden="true">
                      <div className={styles.barFill} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className={styles.muted}>Limits reset on the 1st of each month (UTC).</p>
        </section>
      ) : null}

      {isPremium ? (
        <section className={styles.card} aria-labelledby="manage">
          <h2 id="manage" className={styles.sectionTitle}>
            Manage subscription
          </h2>
          <p className={styles.muted}>Change your card, download invoices or cancel. You keep Premium until the end of the period you have paid for.</p>
          <button type="button" className={styles.secondaryButton} onClick={openPortal} disabled={busy !== null}>
            {busy === "portal" ? "Opening…" : "Manage subscription"}
          </button>
        </section>
      ) : (
        <section className={styles.card} aria-labelledby="upgrade">
          <h2 id="upgrade" className={styles.sectionTitle}>
            Go Premium
          </h2>
          <ul className={styles.perks}>
            {PERKS.map((perk) => (
              <li key={perk}>{perk}</li>
            ))}
          </ul>
          <div className={styles.prices}>
            {(Object.keys(PRICES) as Interval[]).map((interval) => (
              <button
                key={interval}
                type="button"
                className={styles.priceButton}
                onClick={() => startCheckout(interval)}
                disabled={busy !== null}
              >
                <span className={styles.priceLabel}>{PRICES[interval].label}</span>
                <span className={styles.priceSub}>{PRICES[interval].per}</span>
                {PRICES[interval].note ? <span className={styles.priceNote}>{PRICES[interval].note}</span> : null}
                <span className={styles.priceCta}>{busy === interval ? "Opening checkout…" : "Subscribe"}</span>
              </button>
            ))}
          </div>
          <p className={styles.muted}>Cancel any time. Payments are handled securely by Stripe.</p>
        </section>
      )}

      {actionError ? (
        <p className={styles.error} role="alert">
          {actionError}
        </p>
      ) : null}
    </main>
  );
}
