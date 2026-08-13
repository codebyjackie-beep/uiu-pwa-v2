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
type Mode = "link" | "photo" | "manual";
const MAX_PHOTOS = 3;

const MEAL_TYPE_OPTIONS = ["breakfast", "lunch", "dinner", "snack", "dessert"];

type ManualIngredientRow = { name: string; quantity: string; unit: string };

export function SaveFromLinkModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("link");
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [platform, setPlatform] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const [manualTitle, setManualTitle] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [manualIngredients, setManualIngredients] = useState<ManualIngredientRow[]>([{ name: "", quantity: "", unit: "" }]);
  const [manualSteps, setManualSteps] = useState<string[]>([""]);
  const [manualTags, setManualTags] = useState("");
  const [manualMealType, setManualMealType] = useState("");
  const [manualServings, setManualServings] = useState("");
  const [manualPrepTime, setManualPrepTime] = useState("");
  const [manualCookTime, setManualCookTime] = useState("");

  const manualValid =
    manualTitle.trim() !== "" &&
    manualIngredients.some((row) => row.name.trim() !== "") &&
    manualSteps.some((s) => s.trim() !== "");

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

  async function submitManual() {
    if (!manualValid || submitting) return;
    setError(null);
    setSubmitting(true);
    const ingredients = manualIngredients
      .filter((row) => row.name.trim() !== "")
      .map((row) => ({ name: row.name.trim(), quantity: Number(row.quantity) || 0, unit: row.unit.trim() }));
    const steps = manualSteps.map((s) => s.trim()).filter((s) => s !== "");
    const tags = manualTags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    const { parsed } = await fetchJson<{ recipeDraftId: string }>("/api/recipe-import/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: manualTitle.trim(),
        description: manualDescription.trim(),
        ingredients,
        steps,
        tags,
        mealType: manualMealType || undefined,
        servings: manualServings ? Number(manualServings) : undefined,
        prepTimeMinutes: manualPrepTime ? Number(manualPrepTime) : undefined,
        cookTimeMinutes: manualCookTime ? Number(manualCookTime) : undefined,
      }),
    });
    setSubmitting(false);
    if (!parsed || !parsed.ok) {
      setError(parsed && !parsed.ok ? parsed.error.message : "Something went wrong — please try again.");
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
          <h3 className="meal-planner-modal__title">Add a recipe</h3>
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
              <button
                type="button"
                className={`chip${mode === "manual" ? " chip--active" : ""}`}
                disabled={submitting}
                onClick={() => {
                  setMode("manual");
                  setError(null);
                }}
              >
                Manually
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

          {step === "url" && mode === "manual" ? (
            <>
              <p className="admin-drafts-page__sub">Type your own recipe in — nothing here is parsed or checked by AI.</p>
              <input
                type="text"
                placeholder="Title"
                value={manualTitle}
                disabled={submitting}
                onChange={(e) => setManualTitle(e.target.value)}
              />
              <textarea
                rows={2}
                placeholder="Description (optional)"
                value={manualDescription}
                disabled={submitting}
                onChange={(e) => setManualDescription(e.target.value)}
              />

              <p className="admin-drafts-page__sub">Ingredients</p>
              {manualIngredients.map((row, i) => (
                <div key={i} className="manual-recipe-form__row">
                  <input
                    type="text"
                    placeholder="Name"
                    value={row.name}
                    disabled={submitting}
                    onChange={(e) => {
                      const next = [...manualIngredients];
                      next[i] = { ...next[i], name: e.target.value };
                      setManualIngredients(next);
                    }}
                  />
                  <input
                    type="text"
                    placeholder="Qty"
                    value={row.quantity}
                    disabled={submitting}
                    onChange={(e) => {
                      const next = [...manualIngredients];
                      next[i] = { ...next[i], quantity: e.target.value };
                      setManualIngredients(next);
                    }}
                  />
                  <input
                    type="text"
                    placeholder="Unit"
                    value={row.unit}
                    disabled={submitting}
                    onChange={(e) => {
                      const next = [...manualIngredients];
                      next[i] = { ...next[i], unit: e.target.value };
                      setManualIngredients(next);
                    }}
                  />
                  {manualIngredients.length > 1 ? (
                    <button
                      type="button"
                      className="manual-recipe-form__remove"
                      disabled={submitting}
                      onClick={() => setManualIngredients(manualIngredients.filter((_, idx) => idx !== i))}
                      aria-label="Remove ingredient"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                className="chip"
                disabled={submitting}
                onClick={() => setManualIngredients([...manualIngredients, { name: "", quantity: "", unit: "" }])}
              >
                + Add ingredient
              </button>

              <p className="admin-drafts-page__sub">Steps</p>
              {manualSteps.map((s, i) => (
                <div key={i} className="manual-recipe-form__row">
                  <textarea
                    rows={2}
                    placeholder={`Step ${i + 1}`}
                    value={s}
                    disabled={submitting}
                    onChange={(e) => {
                      const next = [...manualSteps];
                      next[i] = e.target.value;
                      setManualSteps(next);
                    }}
                  />
                  {manualSteps.length > 1 ? (
                    <button
                      type="button"
                      className="manual-recipe-form__remove"
                      disabled={submitting}
                      onClick={() => setManualSteps(manualSteps.filter((_, idx) => idx !== i))}
                      aria-label="Remove step"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
              <button type="button" className="chip" disabled={submitting} onClick={() => setManualSteps([...manualSteps, ""])}>
                + Add step
              </button>

              <input
                type="text"
                placeholder="Tags, comma separated (optional)"
                value={manualTags}
                disabled={submitting}
                onChange={(e) => setManualTags(e.target.value)}
              />
              <select value={manualMealType} disabled={submitting} onChange={(e) => setManualMealType(e.target.value)}>
                <option value="">Meal type (optional)</option>
                {MEAL_TYPE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt[0].toUpperCase() + opt.slice(1)}
                  </option>
                ))}
              </select>
              <input
                type="number"
                placeholder="Servings (default 2)"
                value={manualServings}
                disabled={submitting}
                onChange={(e) => setManualServings(e.target.value)}
              />
              <input
                type="number"
                placeholder="Prep time (mins, default 0)"
                value={manualPrepTime}
                disabled={submitting}
                onChange={(e) => setManualPrepTime(e.target.value)}
              />
              <input
                type="number"
                placeholder="Cook time (mins, default 0)"
                value={manualCookTime}
                disabled={submitting}
                onChange={(e) => setManualCookTime(e.target.value)}
              />

              {error ? <p className="admin-drafts-error">{error}</p> : null}
              <button type="button" className="wizard-primary-button" disabled={submitting || !manualValid} onClick={() => void submitManual()}>
                {submitting ? "Saving…" : "Save"}
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
