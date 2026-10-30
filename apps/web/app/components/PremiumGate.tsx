"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ApiResponse, MyPlan } from "@uiu/shared";

/**
 * Milestone 3 phase C2 (Jackie 2026-10-28): one place that turns the API's Premium gate errors into an
 * upgrade prompt. apps/api answers `premium_required` (free user, Premium feature) and `limit_reached`
 * (monthly allowance used). The web proxy routes pass those bodies through unchanged, so this watches
 * same-origin /api/ responses and shows the prompt, rather than each feature handling it on its own.
 */
type GateState =
  | { kind: "premium_required" }
  | { kind: "limit_reached"; message: string; resetsAt: string | null }
  | null;

const EVENT = "uiu:premium-gate";

function resetLabel(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

let installed = false;

/** Wraps window.fetch once. Only reads the body of JSON responses from our own /api/ routes. */
function installGateFetch() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const isOwnApi = url.startsWith("/api/") || url.startsWith(window.location.origin + "/api/");
      if (!isOwnApi || !(res.headers.get("content-type") ?? "").includes("application/json")) return res;
      const body = (await res.clone().json().catch(() => null)) as
        | { ok?: boolean; error?: { code?: string; message?: string }; data?: { resetsAt?: string } }
        | null;
      const code = body?.ok === false ? body.error?.code : undefined;
      if (code === "premium_required") {
        window.dispatchEvent(new CustomEvent<GateState>(EVENT, { detail: { kind: "premium_required" } }));
      } else if (code === "limit_reached") {
        window.dispatchEvent(
          new CustomEvent<GateState>(EVENT, {
            detail: { kind: "limit_reached", message: body?.error?.message ?? "Monthly limit reached", resetsAt: body?.data?.resetsAt ?? null },
          }),
        );
      }
    } catch {
      // never break the original request
    }
    return res;
  }) as typeof window.fetch;
}

/** Milestone 3 trial notices. Banner in the last 3 trial days; a one-time paywall after the trial ends. */
const BANNER_DAYS = 3;
const PAYWALL_KEY_PREFIX = "uiu-trial-paywall-";

function daysLeft(iso: string): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
}

export function PremiumGate() {
  const [gate, setGate] = useState<GateState>(null);
  const [plan, setPlan] = useState<MyPlan | null>(null);
  const [bannerHidden, setBannerHidden] = useState(false);
  const [paywall, setPaywall] = useState(false);

  useEffect(() => {
    installGateFetch();
    const onGate = (e: Event) => setGate((e as CustomEvent<GateState>).detail);
    window.addEventListener(EVENT, onGate);
    fetch("/api/me/plan", { cache: "no-store" })
      .then((r) => r.json() as Promise<ApiResponse<MyPlan>>)
      .then((j) => {
        if (!j.ok) return;
        setPlan(j.data);
        // Paywall: once, after a trial that ended without a subscription. The flag is per viewer, keyed to the trial end.
        const ended = j.data.plan === "free" && j.data.trialEndsAt && Date.parse(j.data.trialEndsAt) <= Date.now() && !j.data.premiumUntil;
        if (ended && j.data.trialEndsAt) {
          try {
            const key = PAYWALL_KEY_PREFIX + j.data.trialEndsAt;
            if (!localStorage.getItem(key)) {
              localStorage.setItem(key, "1");
              setPaywall(true);
            }
          } catch {
            // storage blocked: skip the one-time flag, show nothing extra
          }
        }
      })
      .catch(() => {});
    return () => window.removeEventListener(EVENT, onGate);
  }, []);

  const trialDays = plan?.plan === "trial" && plan.trialEndsAt ? daysLeft(plan.trialEndsAt) : null;
  const showBanner = !bannerHidden && trialDays !== null && trialDays <= BANNER_DAYS && trialDays > 0;

  if (paywall && !gate) {
    return (
      <div className="meal-planner-modal-overlay" onClick={() => setPaywall(false)}>
        <div className="meal-planner-modal" role="dialog" aria-modal="true" aria-labelledby="trial-ended-title" onClick={(e) => e.stopPropagation()}>
          <div className="meal-planner-modal__header">
            <h3 id="trial-ended-title" className="meal-planner-modal__title">Your free trial has ended</h3>
            <button type="button" className="meal-planner-modal__close" aria-label="Close" onClick={() => setPaywall(false)}>
              ×
            </button>
          </div>
          <div className="meal-planner-modal__body">
            <p>Your AI features are now on the free plan. Subscribe to keep the Nutrition Coach, meal plan wizard, barcode scanning, photo imports and more.</p>
            <Link href="/premium" className="wizard-primary-button" onClick={() => setPaywall(false)} style={{ display: "inline-block", marginTop: 12, textAlign: "center" }}>
              See Premium — £2.99/month
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (showBanner && !gate) {
    return (
      <div role="status" style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", gap: 12, padding: "8px 12px", background: "var(--uiu-green)", color: "var(--on-accent)", fontSize: 14 }}>
        <span>
          {trialDays === 1 ? "Last day" : `${trialDays} days left`} of your free Premium trial.
        </span>
        <Link href="/premium" style={{ color: "inherit", fontWeight: 700, textDecoration: "underline" }}>
          See Premium
        </Link>
        <button type="button" aria-label="Hide" onClick={() => setBannerHidden(true)} style={{ background: "none", border: 0, color: "inherit", fontSize: 18, cursor: "pointer" }}>
          ×
        </button>
      </div>
    );
  }

  if (!gate) return null;
  const close = () => setGate(null);
  const reset = gate.kind === "limit_reached" ? resetLabel(gate.resetsAt) : null;

  return (
    <div className="meal-planner-modal-overlay" onClick={close}>
      <div className="meal-planner-modal" role="dialog" aria-modal="true" aria-labelledby="premium-gate-title" onClick={(e) => e.stopPropagation()}>
        <div className="meal-planner-modal__header">
          <h3 id="premium-gate-title" className="meal-planner-modal__title">
            {gate.kind === "premium_required" ? "This is a Premium feature" : "Monthly limit reached"}
          </h3>
          <button type="button" className="meal-planner-modal__close" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        <div className="meal-planner-modal__body">
          {gate.kind === "premium_required" ? (
            <p>Upgrade to UseItUp Premium to use AI Nutrition Coach, the meal plan wizard, barcode scanning, photo imports and more.{plan && !plan.trialEndsAt ? " Your first 7 days are free." : ""}</p>
          ) : (
            <p>
              {gate.message}
              {reset ? ` It resets on ${reset}.` : ""}
            </p>
          )}
          <Link href="/premium" className="wizard-primary-button" onClick={close} style={{ display: "inline-block", marginTop: 12, textAlign: "center" }}>
            See Premium
          </Link>
        </div>
      </div>
    </div>
  );
}
