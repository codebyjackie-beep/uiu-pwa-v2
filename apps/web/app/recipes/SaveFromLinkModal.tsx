"use client";

import { useRef, useState } from "react";
import type { ApiResponse } from "@uiu/shared";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; parsed: ApiResponse<T> | null }> {
  const res = await fetch(path, init);
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return { res, parsed };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

type Step = "url" | "manual-paste" | "done";
type Mode = "link" | "photo";
const MAX_PHOTOS = 3;

export function SaveFromLinkModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("link");
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [platform, setPlatform] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

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

  async function submitPhotos(files: File[]) {
    if (files.length === 0 || submitting) return;
    setError(null);
    setSubmitting(true);
    const images = await Promise.all(files.slice(0, MAX_PHOTOS).map(fileToDataUrl));
    const { parsed } = await fetchJson<{ recipeDraftId?: string; needsManualPaste?: true }>("/api/recipe-import/from-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images }),
    });
    setSubmitting(false);
    if (!parsed || !parsed.ok) {
      setError(parsed && !parsed.ok ? parsed.error.message : "Something went wrong — please try again.");
      return;
    }
    if (parsed.data.needsManualPaste) {
      setPlatform(null);
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
            <div className="recipe-import-form__tabs">
              <button
                type="button"
                className={`chip${mode === "link" ? " chip--active" : ""}`}
                disabled={submitting}
                onClick={() => {
                  setMode("link");
                  setError(null);
                }}
              >
                Paste a link
              </button>
              <button
                type="button"
                className={`chip${mode === "photo" ? " chip--active" : ""}`}
                disabled={submitting}
                onClick={() => {
                  setMode("photo");
                  setError(null);
                }}
              >
                Take a photo
              </button>
            </div>
          ) : null}

          {step === "url" && mode === "link" ? (
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

          {step === "url" && mode === "photo" ? (
            <>
              <p className="admin-drafts-page__sub">
                Take or choose up to {MAX_PHOTOS} photos of a handwritten or printed recipe (e.g. both sides of a
                recipe card, or two facing pages).
              </p>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                hidden
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []).slice(0, MAX_PHOTOS);
                  e.target.value = "";
                  if (files.length > 0) void submitPhotos(files);
                }}
              />
              {error ? <p className="admin-drafts-error">{error}</p> : null}
              <button
                type="button"
                className="wizard-primary-button"
                disabled={submitting}
                onClick={() => photoInputRef.current?.click()}
              >
                {submitting ? "Analyzing…" : "Choose photo(s)"}
              </button>
            </>
          ) : null}

          {step === "manual-paste" ? (
            <>
              <p className="admin-drafts-page__sub">
                {mode === "photo"
                  ? "Couldn't read that photo clearly. Copy the recipe text and paste it below instead."
                  : `We couldn't automatically read this link${platform ? ` (${platform})` : ""}. Copy the caption or recipe text from the app and paste it below instead.`}
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
