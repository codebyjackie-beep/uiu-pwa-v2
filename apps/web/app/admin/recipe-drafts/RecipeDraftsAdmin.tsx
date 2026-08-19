"use client";

import { useEffect, useState } from "react";
import type { ApiResponse, RecipeCostLine, RecipeDraft, RecipeIngredient, RecipeDraftStatus } from "@uiu/shared";
import { MealTagPicker } from "../_shared/MealTagPicker";

type Session = "loading" | "authed" | "anon";

type StatusFilter = RecipeDraftStatus | "all";

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

const PAGE_SIZE = 25;

interface DraftEdit {
  title: string;
  description: string;
  ingredients: RecipeIngredient[];
  steps: string[];
  tags: string[];
  servings: number;
  prepTimeMinutes: number;
  cookTimeMinutes: number;
}

function toEdit(d: RecipeDraft): DraftEdit {
  return {
    title: d.title,
    description: d.description,
    ingredients: d.ingredients.map((i) => ({ ...i })),
    steps: [...d.steps],
    tags: [...d.tags],
    servings: d.servings,
    prepTimeMinutes: d.prepTimeMinutes,
    cookTimeMinutes: d.cookTimeMinutes,
  };
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) {
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    if (hours <= 0) return "just now";
    return `${hours}h ago`;
  }
  return `${days}d ago`;
}

function formatCost(v: number | null | undefined): string {
  return v != null ? `£${v.toFixed(2)}/serving` : "未計到價";
}

/** HANDOFF_recipe-drafts-admin-gram-display.md — display rule per ingredient line. */
function gramHint(line: RecipeCostLine | undefined): { text: string; warning: boolean } | null {
  if (!line) return null;
  if (line.priceable && line.normUnit === "g" && line.normValue != null) {
    return { text: `≈${Math.round(line.normValue)}g`, warning: false };
  }
  if (line.priceable && line.normUnit === "ml" && line.normValue != null) {
    return { text: `≈${Math.round(line.normValue)}ml`, warning: false };
  }
  if (line.bucket === "count") return null;
  if (!line.priceable && line.reason === "missing_density_cup") {
    return { text: "⚠️ 未有克數換算資料", warning: true };
  }
  return null;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; parsed: ApiResponse<T> | null }> {
  const res = await fetch(path, init);
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return { res, parsed };
}

export function RecipeDraftsAdmin() {
  const [session, setSession] = useState<Session>("loading");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [page, setPage] = useState(1);
  const [drafts, setDrafts] = useState<RecipeDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<DraftEdit | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [staleIds, setStaleIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [costLinesById, setCostLinesById] = useState<Record<string, RecipeCostLine[] | "loading" | "error">>({});

// Probes the session on mount by attempting the pending-list fetch itself — a valid
  // admin_session cookie makes it succeed, a missing/expired one returns 401.
  useEffect(() => {
    void loadDrafts("pending");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (session !== "authed") return;
    void loadDrafts(statusFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function loadDrafts(status: StatusFilter) {
    setLoading(true);
    setListError(null);
    const { res, parsed } = await fetchJson<RecipeDraft[]>(`/api/admin/recipe-drafts?status=${status}`);
    if (res.status === 401) {
      setSession("anon");
      setLoading(false);
      return;
    }
    setSession("authed");
    if (!parsed || !parsed.ok) {
      setListError(parsed && !parsed.ok ? parsed.error.message : "讀取失敗，請重試。");
      setLoading(false);
      return;
    }
    setDrafts(parsed.data);
    setPage(1);
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
    void loadDrafts(statusFilter);
  }

  async function loadCostLines(id: string) {
    if (costLinesById[id]) return;
    setCostLinesById((prev) => ({ ...prev, [id]: "loading" }));
    const { res, parsed } = await fetchJson<RecipeCostLine[]>(`/api/admin/recipe-drafts/${id}/cost-lines`);
    if (res.status === 401) {
      setSession("anon");
      setSessionNotice("Session 已過期，請重新登入。");
      return;
    }
    if (!parsed || !parsed.ok) {
      setCostLinesById((prev) => ({ ...prev, [id]: "error" }));
      return;
    }
    setCostLinesById((prev) => ({ ...prev, [id]: parsed.data }));
  }

  function toggleExpand(d: RecipeDraft) {
    const next = expandedId === d._id ? null : d._id;
    setExpandedId(next);
    if (next) void loadCostLines(d._id);
  }

  function startEdit(d: RecipeDraft) {
    setEditingId(d._id);
    setEdit(toEdit(d));
    setExpandedId(d._id);
  }

  function cancelEdit() {
    setEditingId(null);
    setEdit(null);
  }

  async function saveEdit(id: string) {
    if (!edit) return;
    setSavingId(id);
    const ingredientsChanged = true; // any save that reaches here may have touched ingredients — flag conservatively
    const { res, parsed } = await fetchJson<RecipeDraft>(`/api/admin/recipe-drafts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edit),
    });
    setSavingId(null);
    if (res.status === 401) {
      setSession("anon");
      setSessionNotice("Session 已過期，請重新登入。");
      return;
    }
    if (!parsed || !parsed.ok) {
      setToast(parsed && !parsed.ok ? `儲存失敗：${parsed.error.message}` : "儲存失敗，請重試。");
      return;
    }
    setDrafts((prev) => prev.map((d) => (d._id === id ? parsed.data : d)));
    setStaleIds((prev) => (ingredientsChanged ? new Set(prev).add(id) : prev));
    setEditingId(null);
    setEdit(null);
    setToast("已儲存。");
  }

  async function decide(id: string, action: "approve" | "reject") {
    if (action === "reject" && !window.confirm("確定要 reject 呢條 draft？呢個動作唔會再顯示喺 pending 列表。")) {
      return;
    }
    setDecidingId(id);
    const { res, parsed } = await fetchJson<{ recipeId: string } | { id: string }>(`/api/admin/recipe-drafts/${id}/${action}`, {
      method: "POST",
    });
    setDecidingId(null);
    if (res.status === 401) {
      setSession("anon");
      setSessionNotice("Session 已過期，請重新登入。");
      return;
    }
    if (!parsed || !parsed.ok) {
      setToast(parsed && !parsed.ok ? `${action} 失敗：${parsed.error.message}` : `${action} 失敗，請重試。`);
      return;
    }
    setDrafts((prev) => prev.filter((d) => d._id !== id));
    setToast(action === "approve" ? "已 approve，已加入 recipes。" : "已 reject。");
  }

  if (session === "loading") {
    return (
      <div className="admin-drafts-page">
        <h1>Recipe Drafts Admin</h1>
        <p className="admin-drafts-page__sub">載入緊…</p>
      </div>
    );
  }

  if (session === "anon") {
    return (
      <div className="admin-drafts-page">
        <h1>Recipe Drafts Admin</h1>
        <p className="admin-drafts-page__sub">輸入密碼登入先可以睇 draft。</p>
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
        {sessionNotice ? <p className="admin-drafts-page__sub">{sessionNotice}</p> : null}
        {loginError ? <p className="admin-drafts-error">{loginError}</p> : null}
      </div>
    );
  }

  return (
    <div className="admin-drafts-page">
      <h1>Recipe Drafts Admin</h1>
      <div className="admin-drafts-tabs">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`wizard-chip${statusFilter === t.value ? " wizard-chip--selected" : ""}`}
            onClick={() => setStatusFilter(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {toast ? <p className="admin-drafts-toast">{toast}</p> : null}
      {listError ? <p className="admin-drafts-error">{listError}</p> : null}
      {loading ? <p className="admin-drafts-page__sub">載入緊…</p> : null}
      {!loading && drafts.length === 0 && !listError ? <p className="admin-drafts-page__sub">冇 {statusFilter} 嘅 draft。</p> : null}
      {!loading && drafts.length > 0 ? <p className="admin-drafts-page__sub">共 {drafts.length} 條 draft</p> : null}

      <div className="admin-drafts-list">
        {drafts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((d) => {
          const expanded = expandedId === d._id;
          const isEditing = editingId === d._id;
          return (
            <div key={d._id} className="admin-drafts-card">
              <button
                type="button"
                className="admin-drafts-card__header"
                onClick={() => toggleExpand(d)}
              >
                {d.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={d.imageUrl} alt="" className="admin-drafts-card__thumb" />
                ) : (
                  <span className="admin-drafts-card__thumb admin-drafts-card__thumb--placeholder">未有相</span>
                )}
                <div className="admin-drafts-card__header-main">
                  <p className="admin-drafts-card__title">{d.title}</p>
                  <p className="admin-drafts-card__meta">
                    靈感嚟源：{d.sourceInspiration} · {d.mealType ?? "—"} · {d.servings} servings · {d.prepTimeMinutes}+{d.cookTimeMinutes} min
                  </p>
                </div>
                <span className="admin-drafts-card__price">
                  {formatCost(d.costPreview?.perServing)}
                  {staleIds.has(d._id) ? <span className="admin-drafts-stale"> (可能未反映最新食材)</span> : null}
                </span>
              </button>

              <div className="admin-drafts-card__chips">
                {d.tags.map((t) => (
                  <span key={t} className="wizard-chip">
                    {t}
                  </span>
                ))}
              </div>

              <p className="admin-drafts-card__sub">
                {d.nutrition.calories} cal · {d.nutrition.protein}g protein · {d.nutrition.carbs}g carbs · {d.nutrition.fat}g fat ·{" "}
                {relativeTime(d.createdAt)}
              </p>

              {expanded ? (
                isEditing && edit ? (
                  <EditForm edit={edit} setEdit={setEdit} onSave={() => saveEdit(d._id)} onCancel={cancelEdit} saving={savingId === d._id} />
                ) : (
                  <div className="admin-drafts-detail">
                    <p>{d.description}</p>
                    <h4>食材</h4>
                    {costLinesById[d._id] === "loading" ? <p className="admin-drafts-page__sub">計緊克數…</p> : null}
                    {costLinesById[d._id] === "error" ? <p className="admin-drafts-page__sub">克數換算讀取失敗（唔影響食材本身）。</p> : null}
                    <ul className="admin-drafts-ingredient-list">
                      {d.ingredients.map((ing, i) => {
                        const lines = costLinesById[d._id];
                        const line = Array.isArray(lines) ? lines[i] : undefined;
                        const hint = gramHint(line);
                        return (
                          <li key={i}>
                            {ing.quantity} {ing.unit} {ing.name}
                            {hint ? (
                              <span className={hint.warning ? "admin-drafts-gram-hint admin-drafts-gram-hint--warning" : "admin-drafts-gram-hint"}>
                                {" "}
                                {hint.text}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                    <h4>做法</h4>
                    <ol className="admin-drafts-step-list">
                      {d.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </div>
                )
              ) : null}

              {expanded && !isEditing ? (
                <div className="admin-drafts-card__actions">
                  {d.status === "pending" ? (
                    <button type="button" className="wizard-secondary-button" onClick={() => startEdit(d)}>
                      編輯
                    </button>
                  ) : null}
                  {d.status === "pending" ? (
                    <>
                      <button
                        type="button"
                        className="wizard-primary-button"
                        disabled={decidingId === d._id}
                        onClick={() => decide(d._id, "approve")}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="admin-drafts-reject-button"
                        disabled={decidingId === d._id}
                        onClick={() => decide(d._id, "reject")}
                      >
                        Reject
                      </button>
                    </>
                  ) : (
                    <span className="admin-drafts-card__sub">狀態：{d.status}</span>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {drafts.length > 0 ? (
        <div className="recipes-page__pagination">
          {page > 1 ? (
            <button type="button" onClick={() => setPage((p) => p - 1)}>
              ← Prev
            </button>
          ) : (
            <span aria-disabled="true">← Prev</span>
          )}
          <span>
            Page {page} / {Math.max(1, Math.ceil(drafts.length / PAGE_SIZE))}
          </span>
          {page < Math.ceil(drafts.length / PAGE_SIZE) ? (
            <button type="button" onClick={() => setPage((p) => p + 1)}>
              Next →
            </button>
          ) : (
            <span aria-disabled="true">Next →</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function EditForm({
  edit,
  setEdit,
  onSave,
  onCancel,
  saving,
}: {
  edit: DraftEdit;
  setEdit: (e: DraftEdit) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  function updateIngredient(i: number, field: keyof RecipeIngredient, value: string | number) {
    const next = edit.ingredients.map((ing, idx) => (idx === i ? { ...ing, [field]: value } : ing));
    setEdit({ ...edit, ingredients: next });
  }
  function addIngredient() {
    setEdit({ ...edit, ingredients: [...edit.ingredients, { name: "", quantity: 0, unit: "" }] });
  }
  function removeIngredient(i: number) {
    setEdit({ ...edit, ingredients: edit.ingredients.filter((_, idx) => idx !== i) });
  }

  function updateStep(i: number, value: string) {
    setEdit({ ...edit, steps: edit.steps.map((s, idx) => (idx === i ? value : s)) });
  }
  function addStep() {
    setEdit({ ...edit, steps: [...edit.steps, ""] });
  }
  function removeStep(i: number) {
    setEdit({ ...edit, steps: edit.steps.filter((_, idx) => idx !== i) });
  }
  function moveStep(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= edit.steps.length) return;
    const next = [...edit.steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setEdit({ ...edit, steps: next });
  }

  return (
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

      <p className="admin-drafts-page__sub">如果改咗食材，價錢預覽可能未反映最新內容 — approve 之後可以等 weekly cron 重新計算。</p>

      <div className="admin-drafts-card__actions">
        <button type="button" className="wizard-primary-button" disabled={saving} onClick={onSave}>
          {saving ? "儲存緊…" : "儲存"}
        </button>
        <button type="button" className="wizard-secondary-button" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
