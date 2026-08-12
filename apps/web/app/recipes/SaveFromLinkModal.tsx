"use client";

import { useState } from "react";
import type { ApiResponse } from "@uiu/shared";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; parsed: ApiResponse<T> | null }> {
  const res = await fetch(path, init);
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return { res, parsed };
}

type Step = "url" | "manual-paste" | "done";

export function SaveFromLinkModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [platform, setPlatform] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitUrl() {
    const trimmed = url.trim();
    if (!trimmed || submitting) return;
    setError(null);
    setSubmitting(true);
    const { parsed } = await fetchJson<{ recipeDraftId?: string; needsManualPaste?: true; platform?: string | null }>(
      "/api/recipe-import/from-url",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: trimmed }) },
    );
    setSubmitting(false);
    if (!parsed || !parsed.ok) {
      setError(parsed && !parsed.ok ? parsed.error.message : "Something went wrong — please try again.");
      return;
    }
    if (parsed.data.needsManualPaste) {
      setPlatform(parsed.data.platform ?? null);
      setStep("manual-paste");
      return;
    }
    setStep("done");
  }

  async function submitManualPaste() {
    const trimmed = pastedText.trim();
    if (!trimmed || submitting) return;
    setError(null);
    setSubmitting(true);
    const { parsed } = await fetchJson<{ recipeDraftId: string }>("/api/recipe-import/from-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed, url: url.trim() || undefined, platform }),
    });
    setSubmitting(false);
    if (!parsed || !parsed.ok) {
      setError(parsed && !parsed.ok ? parsed.error.message : "Couldn't extract a recipe from that text — please add more detail.");
      return;
    }
    setStep("done");
  }

  return (
    <div className="meal-planner-modal-overlay" onClick={onClose}>
      <div className="meal-planner-modal" onClick={(e) => e.stopPropagation()}>
        <div className="meal-planner-modal__header">
          <h3 className="meal-planner-modal__title">Save recipe from a link</h3>
          <button type="button" className="meal-planner-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="meal-planner-modal__body recipe-import-form">
          {step === "url" ? (
            <>
              <p className="admin-drafts-page__sub">
                Paste a link from TikTok, Instagram, Facebook, Pinterest, YouTube, or any recipe blog.
              </p>
              <input
                type="url"
                placeholder="https://…"
                value={url}
                disabled={submitting}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitUrl();
                }}
              />
              {error ? <p className="admin-drafts-error">{error}</p> : null}
              <button type="button" className="wizard-primary-button" disabled={submitting || !url.trim()} onClick={() => void submitUrl()}>
                {submitting ? "Saving…" : "Save"}
              </button>
            </>
          ) : null}

          {step === "manual-paste" ? (
            <>
              <p className="admin-drafts-page__sub">
                We couldn&apos;t automatically read this link{platform ? ` (${platform})` : ""}. Copy the caption or recipe text
                from the app and paste it below instead.
              </p>
              <textarea
                rows={8}
                placeholder="Paste the recipe caption or description here…"
                value={pastedText}
                disabled={submitting}
                onChange={(e) => setPastedText(e.target.value)}
              />
              {error ? <p className="admin-drafts-error">{error}</p> : null}
              <button
                type="button"
                className="wizard-primary-button"
                disabled={submitting || !pastedText.trim()}
                onClick={() => void submitManualPaste()}
              >
                {submitting ? "Saving…" : "Save"}
              </button>
            </>
          ) : null}

          {step === "done" ? (
            <>
              <p className="admin-drafts-page__sub">
                Added to the review queue — go to Admin → Recipe Drafts to check and approve it.
              </p>
              <button type="button" className="wizard-primary-button" onClick={onClose}>
                Done
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
