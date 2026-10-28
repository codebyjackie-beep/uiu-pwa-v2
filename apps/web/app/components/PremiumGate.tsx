"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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

export function PremiumGate() {
  const [gate, setGate] = useState<GateState>(null);

  useEffect(() => {
    installGateFetch();
    const onGate = (e: Event) => setGate((e as CustomEvent<GateState>).detail);
    window.addEventListener(EVENT, onGate);
    return () => window.removeEventListener(EVENT, onGate);
  }, []);

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
            <p>Upgrade to UseItUp Premium to use AI Nutrition Coach, the meal plan wizard, barcode scanning, photo imports and more. Your first 7 days are free.</p>
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
