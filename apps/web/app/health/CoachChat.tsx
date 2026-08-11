"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiResponse, NutritionCoachMessage } from "@uiu/shared";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; parsed: ApiResponse<T> | null }> {
  const res = await fetch(path, init);
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return { res, parsed };
}

export function CoachChat({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<NutritionCoachMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { parsed } = await fetchJson<NutritionCoachMessage[]>("/api/health/coach");
      if (cancelled) return;
      setMessages(parsed && parsed.ok ? parsed.data : []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, sending]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setError(null);
    setSending(true);
    setInput("");
    const { parsed } = await fetchJson<{ userMessage: NutritionCoachMessage; assistantMessage: NutritionCoachMessage }>(
      "/api/health/coach",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }) },
    );
    setSending(false);
    if (!parsed || !parsed.ok) {
      setError(parsed && !parsed.ok ? parsed.error.message : "Coach is unavailable right now, please try again.");
      return;
    }
    setMessages((prev) => [...prev, parsed.data.userMessage, parsed.data.assistantMessage]);
  }

  return (
    <div className="meal-planner-modal-overlay" onClick={onClose}>
      <div className="meal-planner-modal health-coach-modal" onClick={(e) => e.stopPropagation()}>
        <div className="meal-planner-modal__header">
          <h3 className="meal-planner-modal__title">AI Nutrition Coach</h3>
          <button type="button" className="meal-planner-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="health-coach-body" ref={bodyRef}>
          {loading ? <p className="admin-drafts-page__sub">Loading conversation…</p> : null}
          {!loading && messages.length === 0 ? (
            <p className="admin-drafts-page__sub">Ask about your meals, weight trend, or general nutrition tips.</p>
          ) : null}
          {messages.map((m) => (
            <div key={m._id} className={`health-coach-bubble health-coach-bubble--${m.role}`}>
              {m.content}
            </div>
          ))}
          {sending ? <div className="health-coach-bubble health-coach-bubble--assistant health-coach-bubble--pending">…</div> : null}
        </div>
        {error ? <p className="admin-drafts-error">{error}</p> : null}
        <div className="health-coach-input-row">
          <input
            type="text"
            value={input}
            placeholder="Ask the coach…"
            disabled={sending}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void send();
            }}
          />
          <button type="button" className="wizard-primary-button" disabled={sending || !input.trim()} onClick={() => void send()}>
            Send
          </button>
        </div>
        <p className="health-disclaimer">AI-generated guidance is approximate — not medical or dietetic advice.</p>
      </div>
    </div>
  );
}
