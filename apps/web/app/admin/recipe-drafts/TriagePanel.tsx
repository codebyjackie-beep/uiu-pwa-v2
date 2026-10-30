"use client";

import { useState } from "react";
import type { ApiResponse } from "@uiu/shared";

/**
 * "Run auto-triage" for /admin/recipe-drafts (apps/api services/recipeDraftTriage.ts).
 *   1. 試算 (plan)  — read-only: how many would be approved / rejected / need review.
 *   2. 執行 (apply) — sends ≤10 ids per request; the API re-checks every rule itself.
 *   3. 撤回 (rollback) — undoes exactly this run's batch (dry-run count first).
 */

type Verdict = "approve_candidate" | "reject" | "needs_review" | "pending";
interface Sample {
  id: string;
  title: string;
  calories: number;
  adjustedCoveragePct: number;
  reasons: string[];
}
interface Plan {
  totalPending: number;
  counts: Record<Verdict, number>;
  rejectReasonCounts: Record<string, number>;
  sanityGateTripped: boolean;
  samples: Record<Verdict, Sample[]>;
  ids: { approve_candidate: string[]; reject: string[]; needs_review: string[] };
}
interface ChunkResult {
  batchId: string;
  approved: string[];
  rejected: string[];
  needsReviewMarked: string[];
  stayedPending: Array<{ id: string; reason: string }>;
}
interface Rollback {
  batchId: string;
  write: boolean;
  recipes: number;
  recipeCosts: number;
  drafts: number;
  needsReview: number;
  warning?: string;
  after?: { recipesStillTagged: number; draftsStillTagged: number };
}

const CHUNK = 10;

const LABEL: Record<Verdict, string> = {
  approve_candidate: "會 approve（要相 load 到）",
  reject: "會 reject（包括同現有 recipe 太似）",
  needs_review: "營養數唔可信 → Needs review",
  pending: "唔夠條件 → 留 pending 人手睇",
};

async function post<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  const res = await fetch(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return parsed ?? { ok: false, error: { code: `http_${res.status}`, message: "Unexpected response" } };
}

export function TriagePanel({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ batchId: string; approved: number; rejected: number; needsReview: number; stayed: Record<string, number> } | null>(null);
  const [rollback, setRollback] = useState<Rollback | null>(null);

  async function runPlan() {
    setBusy("試算緊…");
    setError(null);
    setResult(null);
    setRollback(null);
    const r = await post<Plan>("/api/admin/recipe-drafts/triage/plan");
    setBusy(null);
    if (!r.ok) return setError(r.error.message);
    setPlan(r.data);
  }

  async function runApply() {
    if (!plan) return;
    const ids = [...plan.ids.approve_candidate, ...plan.ids.reject, ...plan.ids.needs_review];
    if (ids.length === 0) return;
    const msg =
      `確認執行？\n\n` +
      `• 最多 approve ${plan.counts.approve_candidate} 條（相 load 唔到嘅會留 pending）\n` +
      `• reject ${plan.counts.reject} 條\n` +
      `• 新標記 Needs review ${plan.ids.needs_review.length} 條（之前已標記嘅唔使再做）\n\n` +
      `全部會標同一個 batch，之後可以一撳撤回。`;
    if (!window.confirm(msg)) return;

    setError(null);
    setBusy("執行緊…");
    setProgress({ done: 0, total: ids.length });
    let batchId: string | undefined;
    const tally = { approved: 0, rejected: 0, needsReview: 0, stayed: {} as Record<string, number> };
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const r = await post<ChunkResult>("/api/admin/recipe-drafts/triage/apply", batchId ? { ids: chunk, batchId } : { ids: chunk });
      if (!r.ok) {
        setError(`第 ${i + 1}–${i + chunk.length} 條出錯：${r.error.message}（已做嘅可以用下面撤回）`);
        break;
      }
      batchId = r.data.batchId;
      tally.approved += r.data.approved.length;
      tally.rejected += r.data.rejected.length;
      tally.needsReview += r.data.needsReviewMarked.length;
      for (const s of r.data.stayedPending) tally.stayed[s.reason] = (tally.stayed[s.reason] ?? 0) + 1;
      setProgress({ done: Math.min(i + CHUNK, ids.length), total: ids.length });
      if (batchId) setResult({ batchId, ...tally });
    }
    setBusy(null);
    setPlan(null);
    onChanged();
  }

  async function runRollback(write: boolean) {
    if (!result) return;
    if (write && !window.confirm(`確認撤回 batch ${result.batchId}？\n會刪走呢批新 recipe，draft 返去 pending。`)) return;
    setBusy(write ? "撤回緊…" : "計緊要撤回幾多…");
    setError(null);
    const r = await post<Rollback>("/api/admin/recipe-drafts/triage/rollback", { batchId: result.batchId, write });
    setBusy(null);
    if (!r.ok) return setError(r.error.message);
    setRollback(r.data);
    if (write) onChanged();
  }

  return (
    <section className="admin-triage-panel">
      <div className="admin-triage-panel__head">
        <strong>Auto-triage</strong>
        <span className="admin-drafts-page__sub">同 10-08 一樣嘅規則：熱量、營養、步驟、材料、重複、價錢 coverage ≥80%、有相</span>
      </div>

      {!plan && !result ? (
        <button type="button" className="wizard-primary-button" disabled={!!busy} onClick={runPlan}>
          Run auto-triage（先試算，唔會改嘢）
        </button>
      ) : null}

      {busy ? <p className="admin-drafts-page__sub">{busy}{progress ? ` ${progress.done}/${progress.total}` : ""}</p> : null}
      {error ? <p className="admin-drafts-error">{error}</p> : null}

      {plan ? (
        <div className="admin-triage-panel__plan">
          <p>Pending 共 {plan.totalPending} 條：</p>
          <ul>
            {(Object.keys(LABEL) as Verdict[]).map((v) => (
              <li key={v}>
                <strong>{plan.counts[v]}</strong> {LABEL[v]}
              </li>
            ))}
          </ul>
          {Object.keys(plan.rejectReasonCounts).length ? (
            <p className="admin-drafts-page__sub">
              Reject 原因：{Object.entries(plan.rejectReasonCounts).map(([k, n]) => `${k} ×${n}`).join("、")}
            </p>
          ) : null}
          {(["approve_candidate", "reject", "pending"] as Verdict[]).map((v) =>
            plan.samples[v].length ? (
              <details key={v}>
                <summary>
                  例子：{LABEL[v]}（{plan.samples[v].length}）
                </summary>
                <ul>
                  {plan.samples[v].map((s) => (
                    <li key={s.id}>
                      {s.title} — {s.calories} kcal · coverage {s.adjustedCoveragePct}%{s.reasons.length && v === "reject" ? ` · ${s.reasons.join("; ")}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null,
          )}
          {plan.sanityGateTripped ? (
            <p className="admin-drafts-error">數字異常（approve &gt; 600 或 reject &gt; 500），多數係規則有 bug，已鎖住唔俾執行。</p>
          ) : (
            <div className="admin-triage-panel__actions">
              <button type="button" className="wizard-primary-button" disabled={!!busy} onClick={runApply}>
                確認執行
              </button>
              <button type="button" className="wizard-chip" disabled={!!busy} onClick={() => setPlan(null)}>
                取消
              </button>
            </div>
          )}
        </div>
      ) : null}

      {result ? (
        <div className="admin-triage-panel__plan">
          <p>
            完成 · batch <code>{result.batchId}</code>
          </p>
          <ul>
            <li>✅ Approved {result.approved}</li>
            <li>🚫 Rejected {result.rejected}</li>
            <li>🔎 Needs review {result.needsReview}</li>
            {Object.entries(result.stayed).map(([k, n]) => (
              <li key={k}>
                ⏸ 留 pending（{k === "no_working_image" ? "冇相" : k === "near_duplicate" ? "同現有 recipe 太似" : k}）{n}
              </li>
            ))}
          </ul>
          {!rollback ? (
            <button type="button" className="admin-drafts-reject-button" disabled={!!busy} onClick={() => runRollback(false)}>
              撤回呢批…
            </button>
          ) : rollback.write ? (
            <p>
              已撤回：刪咗 {rollback.recipes} 條 recipe、{rollback.recipeCosts} 條價錢紀錄，{rollback.drafts} 條 draft 返去 pending。
              {rollback.after ? ` 剩低 tag：${rollback.after.recipesStillTagged} / ${rollback.after.draftsStillTagged}（應該係 0 / 0）` : ""}
            </p>
          ) : (
            <div>
              <p>
                會刪 {rollback.recipes} 條 recipe + {rollback.recipeCosts} 條價錢紀錄，{rollback.drafts} 條 draft 返去 pending。
              </p>
              {rollback.warning ? <p className="admin-drafts-error">{rollback.warning}</p> : null}
              <button type="button" className="admin-drafts-reject-button" disabled={!!busy} onClick={() => runRollback(true)}>
                確認撤回
              </button>
            </div>
          )}
          <button type="button" className="wizard-chip" disabled={!!busy} onClick={() => { setResult(null); setRollback(null); setProgress(null); }}>
            收埋
          </button>
        </div>
      ) : null}
    </section>
  );
}
