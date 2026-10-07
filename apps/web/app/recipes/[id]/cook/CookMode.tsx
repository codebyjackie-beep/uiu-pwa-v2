"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { extractTimerSeconds, formatMmSs } from "./timer";

export interface CookIngredient {
  id: string;
  name: string;
  quantity: string;
  storeLabel: string;
  price: string | null;
  unpriceable: boolean;
}

interface Props {
  recipeId: string;
  title: string;
  imageUrl: string | null;
  steps: string[];
  ingredients: CookIngredient[];
}

interface Progress {
  done: number[];
  current: number;
}

interface CookTimer {
  id: string;
  label: string;
  totalSeconds: number;
  /** Absolute timestamp (Date.now() + duration) rather than a per-tick countdown, so the
   * remaining time stays correct even if the tab was backgrounded/throttled. */
  endAt: number;
  status: "running" | "ringing";
}

const progressKey = (id: string) => `uiu_cook_progress_${id}`;
const ingredientsKey = (id: string) => `uiu_cook_ingredients_${id}`;

/** cc_prompt_recipe-list-redesign-and-cook-mode.md Part C §1 — all localStorage reads/writes
 * are wrapped in try/catch; any failure (private browsing, quota, corrupt JSON) is treated as
 * "start fresh", never a crash. */
function loadProgress(recipeId: string): Progress | null {
  try {
    const raw = localStorage.getItem(progressKey(recipeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.done) || typeof parsed?.current !== "number") return null;
    return { done: parsed.done.filter((n: unknown) => typeof n === "number"), current: parsed.current };
  } catch {
    return null;
  }
}

function saveProgress(recipeId: string, progress: Progress) {
  try {
    localStorage.setItem(progressKey(recipeId), JSON.stringify(progress));
  } catch {
    // ignore — progress just won't persist this session
  }
}

function clearProgress(recipeId: string) {
  try {
    localStorage.removeItem(progressKey(recipeId));
  } catch {
    // ignore
  }
}

function loadPrepared(recipeId: string): Set<string> {
  try {
    const raw = localStorage.getItem(ingredientsKey(recipeId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x: unknown) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function savePrepared(recipeId: string, ids: Set<string>) {
  try {
    localStorage.setItem(ingredientsKey(recipeId), JSON.stringify([...ids]));
  } catch {
    // ignore
  }
}

/** Short beep via the Web Audio API — handoff explicitly says not to add an npm dependency
 * for this. Silently no-ops if AudioContext is unavailable; vibrate + visual cue still fire. */
function playBeep() {
  try {
    const AudioCtx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
    osc.onended = () => {
      ctx.close().catch(() => {});
    };
  } catch {
    // no audio support — vibrate + visual cue are the fallback alert
  }
}

export function CookMode({ recipeId, title, imageUrl, steps, ingredients }: Props) {
  const [resumeChoice, setResumeChoice] = useState<"pending" | "resolved">("pending");
  const [savedProgress, setSavedProgress] = useState<Progress | null>(null);
  const [current, setCurrent] = useState(0);
  const [done, setDone] = useState<Set<number>>(new Set());

  const [timers, setTimers] = useState<CookTimer[]>([]);
  const [showAddTimer, setShowAddTimer] = useState(false);
  const [addTimerMinutes, setAddTimerMinutes] = useState(5);
  const ringingRef = useRef<Set<string>>(new Set());

  const [ingredientsOpen, setIngredientsOpen] = useState(false);
  const [prepared, setPrepared] = useState<Set<string>>(new Set());

  const [speaking, setSpeaking] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);

  // Read saved state once on mount; resume prompt shows only when there's real progress to offer.
  useEffect(() => {
    const saved = loadProgress(recipeId);
    if (saved && saved.done.length > 0 && saved.current < steps.length) {
      setSavedProgress(saved);
    } else {
      setResumeChoice("resolved");
    }
    setPrepared(loadPrepared(recipeId));
    setSpeechSupported(typeof window !== "undefined" && "speechSynthesis" in window);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist progress on change — gated on resumeChoice so we never overwrite saved progress
  // before the user has picked "Continue" / "Start over" on the resume prompt.
  useEffect(() => {
    if (resumeChoice !== "resolved") return;
    saveProgress(recipeId, { done: [...done], current });
  }, [recipeId, done, current, resumeChoice]);

  // Once every step is done, clear saved progress — this is the terminal state, nothing to resume.
  useEffect(() => {
    if (resumeChoice === "resolved" && done.size >= steps.length) {
      clearProgress(recipeId);
    }
  }, [resumeChoice, done.size, steps.length, recipeId]);

  useEffect(() => {
    savePrepared(recipeId, prepared);
  }, [recipeId, prepared]);

  // Screen Wake Lock — best-effort, silent no-op when unsupported or refused.
  useEffect(() => {
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    (async () => {
      try {
        if (!("wakeLock" in navigator)) return;
        const s = await navigator.wakeLock.request("screen");
        if (cancelled) {
          await s.release();
        } else {
          sentinel = s;
        }
      } catch {
        // unsupported or refused — no fallback UI per handoff
      }
    })();
    return () => {
      cancelled = true;
      sentinel?.release().catch(() => {});
    };
  }, []);

  // Stop speech whenever the step changes (or on unmount).
  useEffect(() => {
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // ignore
    }
    setSpeaking(false);
    return () => {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        // ignore
      }
    };
  }, [current]);

  // Shared tick: recompute remaining time for all running timers from their absolute endAt,
  // so switching steps or backgrounding the tab never stops/desyncs a running timer.
  useEffect(() => {
    if (timers.length === 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setTimers((prev) =>
        prev.map((t) => {
          if (t.status === "running" && now >= t.endAt && !ringingRef.current.has(t.id)) {
            ringingRef.current.add(t.id);
            playBeep();
            if ("vibrate" in navigator) {
              try {
                navigator.vibrate([200, 100, 200, 100, 200]);
              } catch {
                // ignore
              }
            }
            return { ...t, status: "ringing" as const };
          }
          return t;
        }),
      );
    }, 500);
    return () => clearInterval(interval);
  }, [timers.length]);

  function remainingSeconds(t: CookTimer): number {
    if (t.status === "ringing") return 0;
    return Math.max(0, Math.round((t.endAt - Date.now()) / 1000));
  }

  function startTimer(seconds: number, label: string) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setTimers((prev) => [...prev, { id, label, totalSeconds: seconds, endAt: Date.now() + seconds * 1000, status: "running" }]);
  }

  function dismissTimer(id: string) {
    ringingRef.current.delete(id);
    setTimers((prev) => prev.filter((t) => t.id !== id));
  }

  function toggleDone(checked: boolean) {
    setDone((prev) => {
      const next = new Set(prev);
      if (checked) next.add(current);
      else next.delete(current);
      return next;
    });
    if (checked && current < steps.length - 1) {
      setCurrent((c) => c + 1);
    }
  }

  function goPrev() {
    setCurrent((c) => Math.max(0, c - 1));
  }

  function goNext() {
    setCurrent((c) => Math.min(steps.length - 1, c + 1));
  }

  function toggleSpeak() {
    try {
      if (speaking) {
        window.speechSynthesis.cancel();
        setSpeaking(false);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(steps[current]);
      utterance.lang = "en-GB";
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utterance);
      setSpeaking(true);
    } catch {
      setSpeaking(false);
    }
  }

  function toggleIngredient(id: string) {
    setPrepared((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startOver() {
    setSavedProgress(null);
    setCurrent(0);
    setDone(new Set());
    setResumeChoice("resolved");
  }

  function continueFromSaved() {
    if (savedProgress) {
      setCurrent(savedProgress.current);
      setDone(new Set(savedProgress.done));
    }
    setSavedProgress(null);
    setResumeChoice("resolved");
  }

  const allDone = resumeChoice === "resolved" && done.size >= steps.length;
  const suggestedSeconds = useMemo(() => extractTimerSeconds(steps[current] ?? ""), [steps, current]);
  const backgroundStyle = imageUrl ? { backgroundImage: `url(${imageUrl})` } : undefined;

  if (resumeChoice === "pending") {
    return <div className="cook-mode cook-mode--loading" />;
  }

  if (savedProgress) {
    return (
      <div className="cook-mode cook-mode--prompt">
        <div className="cook-mode__prompt-card">
          <p className="cook-mode__prompt-title">Continue where you left off?</p>
          <p className="cook-mode__prompt-sub">
            You were on step {savedProgress.current + 1} of {steps.length}.
          </p>
          <button type="button" className="cook-mode__prompt-button cook-mode__prompt-button--primary" onClick={continueFromSaved}>
            Continue from step {savedProgress.current + 1}
          </button>
          <button type="button" className="cook-mode__prompt-button" onClick={startOver}>
            Start over
          </button>
          <Link href={`/recipes/${recipeId}`} className="cook-mode__prompt-close">
            Cancel
          </Link>
        </div>
      </div>
    );
  }

  if (allDone) {
    return (
      <div className="cook-mode cook-mode--done">
        <div className="cook-mode__done-card">
          <p className="cook-mode__done-emoji">All done 🎉</p>
          <p className="cook-mode__done-title">{title}</p>
          <Link href={`/recipes/${recipeId}`} className="cook-mode__done-button">
            Back to recipe
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="cook-mode">
      <div className="cook-mode__background" style={backgroundStyle} />
      <div className="cook-mode__overlay" />

      <div className="cook-mode__content">
        <div className="cook-mode__top">
          <Link href={`/recipes/${recipeId}`} className="cook-mode__close" aria-label="Close cook mode">
            ✕
          </Link>
          <div className="cook-mode__progress-track">
            <div className="cook-mode__progress-fill" style={{ width: `${(done.size / steps.length) * 100}%` }} />
          </div>
          <span className="cook-mode__progress-label">
            {done.size} of {steps.length} done
          </span>
        </div>

        <div className="cook-mode__step-area">
          <span className="cook-mode__step-label">
            STEP {current + 1} OF {steps.length}
          </span>
          <p className="cook-mode__step-text">{steps[current]}</p>

          {speechSupported && (
            <button type="button" className="cook-mode__speak-button" onClick={toggleSpeak}>
              {speaking ? "⏹ Stop" : "🔊 Read step"}
            </button>
          )}

          <label className="cook-mode__done-checkbox">
            <input type="checkbox" checked={done.has(current)} onChange={(e) => toggleDone(e.target.checked)} />
            Mark as done
          </label>

          {suggestedSeconds != null && (
            <button type="button" className="cook-mode__timer-suggest" onClick={() => startTimer(suggestedSeconds, `Step ${current + 1}`)}>
              ⏱ Start {formatMmSs(suggestedSeconds)}
            </button>
          )}
        </div>
      </div>

      {timers.length > 0 && (
        <div className="cook-mode__timers">
          {timers.map((t) => (
            <div key={t.id} className={t.status === "ringing" ? "cook-timer cook-timer--ringing" : "cook-timer"}>
              <span className="cook-timer__label">{t.label}</span>
              <span className="cook-timer__clock">{t.status === "ringing" ? "Time's up!" : formatMmSs(remainingSeconds(t))}</span>
              <button type="button" className="cook-timer__dismiss" onClick={() => dismissTimer(t.id)} aria-label={t.status === "ringing" ? "Stop alarm" : "Cancel timer"}>
                {t.status === "ringing" ? "Stop" : "✕"}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="cook-mode__sheet">
        <div className="cook-mode__timer-row">
          {showAddTimer ? (
            <div className="cook-mode__add-timer">
              <input
                type="number"
                min={1}
                max={180}
                value={addTimerMinutes}
                onChange={(e) => setAddTimerMinutes(Math.max(1, Number(e.target.value) || 1))}
                className="cook-mode__add-timer-input"
              />
              <span>min</span>
              <button
                type="button"
                className="cook-mode__add-timer-start"
                onClick={() => {
                  startTimer(addTimerMinutes * 60, "Timer");
                  setShowAddTimer(false);
                }}
              >
                Start
              </button>
              <button type="button" className="cook-mode__add-timer-cancel" onClick={() => setShowAddTimer(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="cook-mode__add-timer-open" onClick={() => setShowAddTimer(true)}>
              + Add timer
            </button>
          )}
        </div>

        <div className="cook-mode__nav-row">
          <button type="button" className="cook-mode__nav-button" onClick={goPrev} disabled={current === 0}>
            Prev
          </button>
          <button type="button" className="cook-mode__nav-button" onClick={goNext} disabled={current === steps.length - 1}>
            Next
          </button>
        </div>

        <button type="button" className="cook-mode__ingredients-toggle" onClick={() => setIngredientsOpen(true)}>
          Ingredients ({ingredients.length})
        </button>
      </div>

      {ingredientsOpen && (
        <div className="cook-mode__ingredients-sheet">
          <div className="cook-mode__ingredients-sheet-header">
            <span>Ingredients ({ingredients.length})</span>
            <button type="button" className="cook-mode__ingredients-close" onClick={() => setIngredientsOpen(false)}>
              Done
            </button>
          </div>
          <ul className="cook-mode__ingredients-list">
            {ingredients.map((ing) => (
              <li key={ing.id} className="cook-mode__ingredient-row">
                <label className="cook-mode__ingredient-check">
                  <input type="checkbox" checked={prepared.has(ing.id)} onChange={() => toggleIngredient(ing.id)} />
                  <span
                    className={
                      prepared.has(ing.id)
                        ? "cook-mode__ingredient-name cook-mode__ingredient-name--prepared"
                        : "cook-mode__ingredient-name"
                    }
                  >
                    {ing.name}
                  </span>
                </label>
                <span className="cook-mode__ingredient-qty">{ing.quantity}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
