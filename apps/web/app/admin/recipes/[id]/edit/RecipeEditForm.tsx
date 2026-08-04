"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ApiResponse, Recipe, RecipeIngredient } from "@uiu/shared";
import { MealTagPicker } from "../../../_shared/MealTagPicker";

type Session = "loading" | "authed" | "anon";

interface RecipeEdit {
  title: string;
  description: string;
  ingredients: RecipeIngredient[];
  steps: string[];
  tags: string[];
  servings: number;
  prepTimeMinutes: number;
  cookTimeMinutes: number;
}

function toEdit(r: Recipe): RecipeEdit {
  return {
    title: r.title,
    description: r.description,
    ingredients: r.ingredients.map((i) => ({ ...i })),
    steps: [...r.steps],
    tags: [...r.tags],
    servings: r.servings,
    prepTimeMinutes: r.prepTimeMinutes,
    cookTimeMinutes: r.cookTimeMinutes,
  };
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; parsed: ApiResponse<T> | null }> {
  const res = await fetch(path, init);
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return { res, parsed };
}

export function RecipeEditForm({ recipeId }: { recipeId: string }) {
  const [session, setSession] = useState<Session>("loading");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [edit, setEdit] = useState<RecipeEdit | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void loadRecipe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function loadRecipe() {
    setLoading(true);
    setLoadError(null);
    const { res, parsed } = await fetchJson<Recipe>(`/api/admin/recipes/${recipeId}`);
    if (res.status === 401) {
      setSession("anon");
      setLoading(false);
      return;
    }
    setSession("authed");
    if (!parsed || !parsed.ok) {
      setLoadError(parsed && !parsed.ok ? parsed.error.message : "讀取失敗，請重試。");
      setLoading(false);
      return;
    }
    setRecipe(parsed.data);
    setEdit(toEdit(parsed.data));
    setLoading(false);
  }

  async function login() {
    const trimmed = password.trim();
    if (!trimmed) return;
    setLoggingIn(true);
    setLoginError(null);
    const res = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: trimmed }),
    });
    setLoggingIn(false);
    if (!res.ok) {
      setLoginError("密碼錯誤，請重試。");
      return;
    }
    setPassword("");
    setSession("authed");
    void loadRecipe();
  }

  async function saveEdit() {
    if (!edit) return;
    setSaving(true);
    const { res, parsed } = await fetchJson<Recipe>(`/api/admin/recipes/${recipeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edit),
    });
    setSaving(false);
    if (res.status === 401) {
      setSession("anon");
      setToast("Session 已過期，請重新登入。");
      return;
    }
    if (!parsed || !parsed.ok) {
      setToast(parsed && !parsed.ok ? `儲存失敗：${parsed.error.message}` : "儲存失敗，請重試。");
      return;
    }
    setRecipe(parsed.data);
    setEdit(toEdit(parsed.data));
    setToast("已儲存。");
  }

  function updateIngredient(i: number, field: keyof RecipeIngredient, value: string | number) {
    if (!edit) return;
    setEdit({ ...edit, ingredients: edit.ingredients.map((ing, idx) => (idx === i ? { ...ing, [field]: value } : ing)) });
  }
  function addIngredient() {
    if (!edit) return;
    setEdit({ ...edit, ingredients: [...edit.ingredients, { name: "", quantity: 0, unit: "" }] });
  }
  function removeIngredient(i: number) {
    if (!edit) return;
    setEdit({ ...edit, ingredients: edit.ingredients.filter((_, idx) => idx !== i) });
  }

  function updateStep(i: number, value: string) {
    if (!edit) return;
    setEdit({ ...edit, steps: edit.steps.map((s, idx) => (idx === i ? value : s)) });
  }
  function addStep() {
    if (!edit) return;
    setEdit({ ...edit, steps: [...edit.steps, ""] });
  }
  function removeStep(i: number) {
    if (!edit) return;
    setEdit({ ...edit, steps: edit.steps.filter((_, idx) => idx !== i) });
  }
  function moveStep(i: number, dir: -1 | 1) {
    if (!edit) return;
    const j = i + dir;
    if (j < 0 || j >= edit.steps.length) return;
    const next = [...edit.steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setEdit({ ...edit, steps: next });
  }

  if (session === "loading" || (session === "authed" && loading && !edit)) {
    return (
      <div className="admin-drafts-page">
        <h1>Edit Recipe</h1>
        <p className="admin-drafts-page__sub">載入緊…</p>
      </div>
    );
  }

  if (session === "anon") {
    return (
      <div className="admin-drafts-page">
        <h1>Edit Recipe</h1>
        <p className="admin-drafts-page__sub">輸入密碼登入先可以編輯。</p>
        <div className="admin-drafts-token-form">
          <label className="wizard-field">
            <span>密碼</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && login()}
              placeholder="輸入密碼"
              autoFocus
            />
          </label>
          <button type="button" className="wizard-primary-button" disabled={loggingIn} onClick={login}>
            {loggingIn ? "登入緊…" : "登入"}
          </button>
        </div>
        {loginError ? <p className="admin-drafts-error">{loginError}</p> : null}
      </div>
    );
  }

  if (loadError || !recipe || !edit) {
    return (
      <div className="admin-drafts-page">
        <h1>Edit Recipe</h1>
        <p className="admin-drafts-error">{loadError ?? "搵唔到呢個 recipe。"}</p>
        <Link href="/admin/recipes" className="wizard-secondary-button">
          返去列表
        </Link>
      </div>
    );
  }

  return (
    <div className="admin-drafts-page">
      <h1>Edit Recipe</h1>
      <p className="admin-drafts-page__sub">_id: {recipe._id}（唔會改變）</p>

      {toast ? <p className="admin-drafts-toast">{toast}</p> : null}

      <div className="admin-drafts-edit-form">
        <label className="wizard-field">
          <span>Title</span>
          <input type="text" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
        </label>
        <label className="wizard-field">
          <span>Description</span>
          <textarea value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} rows={3} />
        </label>

        <div className="wizard-field-row">
          <label className="wizard-field">
            <span>Servings</span>
            <input type="number" min={1} value={edit.servings} onChange={(e) => setEdit({ ...edit, servings: Number(e.target.value) || 1 })} />
          </label>
          <label className="wizard-field">
            <span>Prep min</span>
            <input
              type="number"
              min={0}
              value={edit.prepTimeMinutes}
              onChange={(e) => setEdit({ ...edit, prepTimeMinutes: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="wizard-field">
            <span>Cook min</span>
            <input
              type="number"
              min={0}
              value={edit.cookTimeMinutes}
              onChange={(e) => setEdit({ ...edit, cookTimeMinutes: Number(e.target.value) || 0 })}
            />
          </label>
        </div>

        <h4>食材</h4>
        {edit.ingredients.map((ing, i) => (
          <div key={i} className="admin-drafts-ingredient-row">
            <input type="text" placeholder="name" value={ing.name} onChange={(e) => updateIngredient(i, "name", e.target.value)} />
            <input
              type="number"
              placeholder="qty"
              value={ing.quantity}
              onChange={(e) => updateIngredient(i, "quantity", Number(e.target.value) || 0)}
            />
            <input type="text" placeholder="unit" value={ing.unit} onChange={(e) => updateIngredient(i, "unit", e.target.value)} />
            <button type="button" className="admin-drafts-icon-button" onClick={() => removeIngredient(i)} aria-label="刪除">
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="wizard-secondary-button" onClick={addIngredient}>
          + 加一行食材
        </button>

        <h4>做法</h4>
        {edit.steps.map((s, i) => (
          <div key={i} className="admin-drafts-step-row">
            <span className="admin-drafts-step-row__num">{i + 1}.</span>
            <textarea value={s} onChange={(e) => updateStep(i, e.target.value)} rows={2} />
            <div className="admin-drafts-step-row__controls">
              <button type="button" className="admin-drafts-icon-button" onClick={() => moveStep(i, -1)} aria-label="上移">
                ↑
              </button>
              <button type="button" className="admin-drafts-icon-button" onClick={() => moveStep(i, 1)} aria-label="下移">
                ↓
              </button>
              <button type="button" className="admin-drafts-icon-button" onClick={() => removeStep(i)} aria-label="刪除">
                ✕
              </button>
            </div>
          </div>
        ))}
        <button type="button" className="wizard-secondary-button" onClick={addStep}>
          + 加一步
        </button>

        <h4>Tags</h4>
        <MealTagPicker tags={edit.tags} onChange={(next) => setEdit({ ...edit, tags: next })} />

        <div className="admin-drafts-card__actions">
          <button type="button" className="wizard-primary-button" disabled={saving} onClick={saveEdit}>
            {saving ? "儲存緊…" : "儲存"}
          </button>
          <Link href="/admin/recipes" className="wizard-secondary-button">
            返去列表
          </Link>
        </div>
      </div>
    </div>
  );
}
