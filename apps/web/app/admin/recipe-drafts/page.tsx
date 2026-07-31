"use client";

import { useState } from "react";
import type { ApiResponse, RecipeDraft } from "@uiu/shared";

export default function RecipeDraftsAdminPage() {
  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [drafts, setDrafts] = useState<RecipeDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function loadDrafts(activeToken: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/recipe-drafts", { headers: { "X-Admin-Token": activeToken } });
      const body = (await res.json()) as ApiResponse<RecipeDraft[]>;
      if (!body.ok) {
        setError(body.error.message);
        setDrafts(null);
        return;
      }
      setDrafts(body.data);
    } catch {
      setError("Could not reach the API.");
    } finally {
      setLoading(false);
    }
  }

  function handleUnlock() {
    setToken(tokenInput);
    void loadDrafts(tokenInput);
  }

  async function handleDecision(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/recipe-drafts/${id}/${decision}`, {
        method: "POST",
        headers: { "X-Admin-Token": token },
      });
      const body = (await res.json()) as ApiResponse<unknown>;
      if (!body.ok) {
        setError(body.error.message);
        return;
      }
      setDrafts((prev) => (prev ? prev.filter((d) => d._id !== id) : prev));
    } catch {
      setError("Could not reach the API.");
    } finally {
      setBusyId(null);
    }
  }

  if (!token) {
    return (
      <div className="admin-drafts-page">
        <h1>Recipe Drafts — Admin</h1>
        <div className="admin-drafts-token-form">
          <input
            type="password"
            placeholder="Admin token"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
          />
          <button onClick={handleUnlock}>Unlock</button>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-drafts-page">
      <h1>Recipe Drafts — Admin</h1>
      {loading && <p>Loading…</p>}
      {error && <p className="admin-drafts-error">{error}</p>}
      {!loading && drafts && drafts.length === 0 && <p>No pending drafts.</p>}
      <div className="admin-drafts-list">
        {drafts?.map((draft) => (
          <div key={draft._id} className="admin-drafts-card">
            <h2>{draft.title}</h2>
            {draft.gapTarget && (
              <p className="admin-drafts-gap-badge">
                Gap target: {draft.gapTarget.slot} × {draft.gapTarget.dietary} (was {draft.gapTarget.countBefore} eligible)
              </p>
            )}
            <p className="admin-drafts-meta">Source inspiration: {draft.sourceInspiration}</p>
            <p className="admin-drafts-meta">
              {draft.nutrition.calories} kcal · {draft.nutrition.protein}g protein · {draft.nutrition.carbs}g carbs · {draft.nutrition.fat}g fat
            </p>
            {draft.costPreview && (
              <p className="admin-drafts-meta">
                £{draft.costPreview.perServing.toFixed(2)}/serving · {Math.round(draft.costPreview.adjustedCoveragePct)}% coverage
              </p>
            )}
            <ul className="admin-drafts-ingredients">
              {draft.ingredients.map((ing, i) => (
                <li key={i}>
                  {ing.quantity} {ing.unit} {ing.name}
                </li>
              ))}
            </ul>
            <div className="admin-drafts-tags">{draft.tags.join(", ")}</div>
            <div className="admin-drafts-actions">
              <button disabled={busyId === draft._id} onClick={() => handleDecision(draft._id, "approve")}>
                Approve
              </button>
              <button disabled={busyId === draft._id} onClick={() => handleDecision(draft._id, "reject")}>
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
