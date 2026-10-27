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
type Mode = "link" | "photo" | "video" | "manual";
const MAX_PHOTOS = 3;
/** Gemini takes ~20 MB inline per request; base64 adds a third, so the file itself is capped at 14 MB (API checks too). */
const MAX_VIDEO_BYTES = 14 * 1024 * 1024;

const MEAL_TYPE_OPTIONS = ["breakfast", "lunch", "dinner", "snack", "dessert"];

type ManualIngredientRow = { name: string; quantity: string; unit: string };

/** Mirrors ImportedDraft in apps/api/src/routes/recipeImport.ts (the import endpoints' `data.draft`). */
type ImportedDraftShape = {
  title: string;
  description: string;
  ingredients: { name: string; quantity: number; unit: string }[];
  steps: string[];
  tags: string[];
  mealType?: string;
  servings: number;
  prepTimeMinutes: number;
  cookTimeMinutes: number;
  sourceUrl: string | null;
  sourcePlatform: string | null;
  importMethod: string;
};

type ImportedFrom = { sourceUrl: string | null; sourcePlatform: string | null; importMethod: string };

/** Numeric draft field → form string; 0 means "no data", so it shows blank rather than "0". */
function numberToFormString(n: number): string {
  return n ? String(n) : "";
}

interface SaveFromLinkModalProps {
  onClose: () => void;
  /** Called after a successful save to My recipes, before the done step. */
  onSaved?: () => void;
  /** Pre-fill from a Web Share Target hand-off (HANDOFF_recipe-share-target.md) —
   * a link that was extracted server-side, ready to review/confirm. */
  initialUrl?: string;
  /** Pre-fill from a share with no extractable link — dropped straight into the
   * manual-paste step so the user can review/add detail, same as the existing
   * "couldn't automatically read this link" fallback. */
  initialText?: string;
}

export function SaveFromLinkModal({ onClose, onSaved, initialUrl, initialText }: SaveFromLinkModalProps) {
  const [mode, setMode] = useState<Mode>("link");
  const [step, setStep] = useState<Step>(initialText ? "manual-paste" : "url");
  const [url, setUrl] = useState(initialUrl ?? "");
  const [pastedText, setPastedText] = useState(initialText ?? "");
  const [platform, setPlatform] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const [manualTitle, setManualTitle] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [manualIngredients, setManualIngredients] = useState<ManualIngredientRow[]>([{ name: "", quantity: "", unit: "" }]);
  const [manualSteps, setManualSteps] = useState<string[]>([""]);
  const [manualTags, setManualTags] = useState("");
  const [manualMealType, setManualMealType] = useState("");
  const [manualServings, setManualServings] = useState("");
  const [manualPrepTime, setManualPrepTime] = useState("");
  const [manualCookTime, setManualCookTime] = useState("");
  /** Set when the form was filled from an import draft; null for a hand-typed recipe. */
  const [importedFrom, setImportedFrom] = useState<ImportedFrom | null>(null);

  const manualValid =
    manualTitle.trim() !== "" &&
    manualIngredients.some((row) => row.name.trim() !== "") &&
    manualSteps.some((s) => s.trim() !== "");

  /** Import succeeded: fill the manual form from the draft so the user can fix it, then Save (POST /manual). */
  function openDraftForReview(draft: ImportedDraftShape) {
    setManualTitle(draft.title);
    setManualDescription(draft.description);
    setManualIngredients(
      draft.ingredients.length > 0
        ? draft.ingredients.map((ing) => ({ name: ing.name, quantity: numberToFormString(ing.quantity), unit: ing.unit }))
        : [{ name: "", quantity: "", unit: "" }],
    );
    setManualSteps(draft.steps.length > 0 ? draft.steps : [""]);
    setManualTags(draft.tags.join(", "));
    setManualMealType(draft.mealType && MEAL_TYPE_OPTIONS.includes(draft.mealType) ? draft.mealType : "");
    setManualServings(numberToFormString(draft.servings));
    setManualPrepTime(numberToFormString(draft.prepTimeMinutes));
    setManualCookTime(numberToFormString(draft.cookTimeMinutes));
    setImportedFrom({ sourceUrl: draft.sourceUrl, sourcePlatform: draft.sourcePlatform, importMethod: draft.importMethod });
    setMode("manual");
    setStep("url");
    setError(null);
  }

  async function submitUrl() {
    const trimmed = url.trim();
    if (!trimmed || submitting) return;
    setError(null);
    setSubmitting(true);
    const { parsed } = await fetchJson<{ draft?: ImportedDraftShape; needsManualPaste?: true; platform?: string | null }>(
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
    if (parsed.data.draft) openDraftForReview(parsed.data.draft);
  }

  async function submitPhotos(files: File[]) {
    if (files.length === 0 || submitting) return;
    setError(null);
    setSubmitting(true);
    const images = await Promise.all(files.slice(0, MAX_PHOTOS).map(fileToDataUrl));
    const { parsed } = await fetchJson<{ draft?: ImportedDraftShape; needsManualPaste?: true }>("/api/recipe-import/from-photo", {
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
    if (parsed.data.draft) openDraftForReview(parsed.data.draft);
  }

  async function submitVideo(file: File) {
    if (submitting) return;
    setError(null);
    if (file.size > MAX_VIDEO_BYTES) {
      setError(`That video is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 14 MB. Trim it to the cooking part and try again.`);
      return;
    }
    setSubmitting(true);
    const video = await fileToDataUrl(file);
    const { parsed } = await fetchJson<{ draft?: ImportedDraftShape; needsManualPaste?: true }>("/api/recipe-import/from-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The link the user tried first (e.g. the Instagram reel) is kept as the draft's source credit.
      body: JSON.stringify({ video, sourceUrl: url.trim() || undefined }),
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
    if (parsed.data.draft) openDraftForReview(parsed.data.draft);
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
    const { parsed } = await fetchJson<{ recipeId: string }>("/api/recipe-import/manual", {
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
        // Only sent when the form came from an import; a hand-typed recipe omits them (API defaults to "manual").
        sourceUrl: importedFrom?.sourceUrl ?? undefined,
        sourcePlatform: importedFrom?.sourcePlatform ?? undefined,
        importMethod: importedFrom?.importMethod,
      }),
    });
    setSubmitting(false);
    if (!parsed || !parsed.ok) {
      setError(parsed && !parsed.ok ? parsed.error.message : "Something went wrong — please try again.");
      return;
    }
    onSaved?.();
    setStep("done");
  }

  async function submitManualPaste() {
    const trimmed = pastedText.trim();
    if (!trimmed || submitting) return;
    setError(null);
    setSubmitting(true);
    const { parsed } = await fetchJson<{ draft: ImportedDraftShape }>("/api/recipe-import/from-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed, url: url.trim() || undefined, platform }),
    });
    setSubmitting(false);
    if (!parsed || !parsed.ok) {
      setError(parsed && !parsed.ok ? parsed.error.message : "Couldn't extract a recipe from that text — please add more detail.");
      return;
    }
    openDraftForReview(parsed.data.draft);
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
                  setImportedFrom(null);
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
                  setImportedFrom(null);
                  setError(null);
                }}
              >
                Take a photo
              </button>
              <button
                type="button"
                className={`chip${mode === "video" ? " chip--active" : ""}`}
                disabled={submitting}
                onClick={() => {
                  setMode("video");
                  setImportedFrom(null);
                  setError(null);
                }}
              >
                Upload a video
              </button>
              <button
                type="button"
                className={`chip${mode === "manual" ? " chip--active" : ""}`}
                disabled={submitting}
                onClick={() => {
                  setMode("manual");
                  setImportedFrom(null);
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

          {step === "url" && mode === "video" ? (
            <>
              <p className="admin-drafts-page__sub">
                Choose a cooking video from your phone (for example a reel you saved). AI watches and listens to it,
                in any language, and writes the recipe in English. Max 14 MB — about 1 minute.
              </p>
              <input
                ref={videoInputRef}
                type="file"
                accept="video/mp4,video/quicktime,video/webm,video/*"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void submitVideo(file);
                }}
              />
              {error ? <p className="admin-drafts-error">{error}</p> : null}
              <button
                type="button"
                className="wizard-primary-button"
                disabled={submitting}
                onClick={() => videoInputRef.current?.click()}
              >
                {submitting ? "Watching the video… (up to a minute)" : "Choose a video"}
              </button>
            </>
          ) : null}

          {step === "url" && mode === "manual" ? (
            <>
              {importedFrom ? (
                <p className="admin-drafts-page__sub">Check what we found and fix anything that&apos;s wrong, then Save. Only you can see this recipe.</p>
              ) : (
                <p className="admin-drafts-page__sub">Type your own recipe in — nothing here is parsed or checked by AI. Only you can see this recipe.</p>
              )}
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
                  : mode === "video"
                    ? "Couldn't find a recipe in that video. Copy the caption or recipe text and paste it below instead."
                    : `We couldn't automatically read this link${platform ? ` (${platform})` : ""}. Save the video to your phone and upload it, or copy the caption and paste it below.`}
              </p>
              {mode === "link" ? (
                <button
                  type="button"
                  className="wizard-secondary-button"
                  disabled={submitting}
                  onClick={() => {
                    setMode("video");
                    setStep("url");
                    setError(null);
                  }}
                >
                  Upload the video instead
                </button>
              ) : null}
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
              <p className="admin-drafts-page__sub">Saved to My recipes — only you can see it.</p>
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
