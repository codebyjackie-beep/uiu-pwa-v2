"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ApiResponse } from "@uiu/shared";

type Session = "loading" | "authed" | "anon";
type RecipeSummary = { _id: string; title: string; tags: string[]; createdAt?: string; imageUrl?: string };

const NEW_BADGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 25;

function isNew(createdAt: string | undefined): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < NEW_BADGE_WINDOW_MS;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; parsed: ApiResponse<T> | null }> {
  const res = await fetch(path, init);
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return { res, parsed };
}

export function LiveRecipesAdmin() {
  const [session, setSession] = useState<Session>("loading");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    void loadRecipes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadRecipes() {
    setLoading(true);
    setListError(null);
    const { res, parsed } = await fetchJson<RecipeSummary[]>("/api/admin/recipes");
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
    setRecipes(parsed.data);
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
    void loadRecipes();
  }

  if (session === "loading") {
    return (
      <div className="admin-drafts-page">
        <h1>Live Recipes Admin</h1>
        <p className="admin-drafts-page__sub">載入緊…</p>
      </div>
    );
  }

  if (session === "anon") {
    return (
      <div className="admin-drafts-page">
        <h1>Live Recipes Admin</h1>
        <p className="admin-drafts-page__sub">輸入密碼登入先可以編輯 recipe。</p>
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

  const filtered = search.trim()
    ? recipes.filter((r) => r.title.toLowerCase().includes(search.trim().toLowerCase()))
    : recipes;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function updateSearch(value: string) {
    setSearch(value);
    setPage(1);
  }

  return (
    <div className="admin-drafts-page">
      <h1>Live Recipes Admin</h1>
      <p className="admin-drafts-page__sub">直接編輯已上架嘅 recipe（updateOne，_id 唔會變，同 meal_plans/recipe_cost 嘅 reference 唔受影響）。</p>

      <p className="admin-drafts-page__sub">
        {search.trim() ? `${filtered.length} 條相符（全部 ${recipes.length} 條）` : `共 ${recipes.length} 條 recipe`}
      </p>

      <div className="wizard-field">
        <input type="text" placeholder="搜尋 recipe title…" value={search} onChange={(e) => updateSearch(e.target.value)} />
      </div>

      {listError ? <p className="admin-drafts-error">{listError}</p> : null}
      {loading ? <p className="admin-drafts-page__sub">載入緊…</p> : null}
      {!loading && filtered.length === 0 && !listError ? <p className="admin-drafts-page__sub">冇搵到相符嘅 recipe。</p> : null}

      <div className="admin-drafts-list">
        {visible.map((r) => (
          <Link key={r._id} href={`/admin/recipes/${r._id}/edit`} className="admin-drafts-card admin-drafts-card__header">
            <div className="admin-drafts-card__header-main">
              {r.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.imageUrl} alt="" className="admin-drafts-card__thumb" />
              ) : null}
              <div>
                <p className="admin-drafts-card__title">
                  {r.title}
                  {isNew(r.createdAt) ? <span className="admin-recipes-new-badge">NEW</span> : null}
                </p>
                <p className="admin-drafts-card__meta">{r.tags.join(", ") || "冇 tag"}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {filtered.length > 0 ? (
        <div className="recipes-page__pagination">
          {hasPrev ? (
            <button type="button" onClick={() => setPage((p) => p - 1)}>
              ← Prev
            </button>
          ) : (
            <span aria-disabled="true">← Prev</span>
          )}
          <span>
            Page {page} / {totalPages}
          </span>
          {hasNext ? (
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
